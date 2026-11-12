import { performance } from 'node:perf_hooks';
import { INSTRUCTION_CHECK_INTERVAL } from './config.ts';
import { LUA, BOOTSTRAP, cleanError, createReplyCodec } from './lua-common.ts';
import { createJsonCodec } from './lua-json.ts';
import type { ScriptingConfig } from './config.ts';
import type { LuaApi } from './lua-common.ts';
import type { CommandReply, RespValue } from '../types.ts';
import type { LuaCall } from './plugin.ts';

/** Opaque Fengari `lua_State`. */
export type FengariLuaState = object;
type FengariFunction = (L: FengariLuaState) => number;

/** Members of `fengari.lua` used by the runner. Strings are Lua byte strings (`Uint8Array`). */
export interface FengariLua extends LuaApi<FengariLuaState> {
  LUA_MASKCOUNT: number;
  lua_newstate(): FengariLuaState;
  lua_close(L: FengariLuaState): void;
  lua_newthread(L: FengariLuaState): FengariLuaState;
  lua_pushlstring(L: FengariLuaState, s: Uint8Array, len: number): unknown;
  lua_tolstring(L: FengariLuaState, idx: number): Uint8Array;
  lua_pushcfunction(L: FengariLuaState, fn: FengariFunction): void;
  lua_setfield(L: FengariLuaState, idx: number, k: Uint8Array): void;
  lua_setglobal(L: FengariLuaState, name: Uint8Array): void;
  lua_rawseti(L: FengariLuaState, idx: number, n: number): void;
  lua_pcall(L: FengariLuaState, nargs: number, nresults: number, msgh: number): number;
  lua_dump(
    L: FengariLuaState,
    writer: (L: FengariLuaState, chunk: Uint8Array, size: number, ud: unknown) => number,
    data: unknown,
    strip: boolean,
  ): number;
  lua_resume(L: FengariLuaState, from: FengariLuaState | null, nargs: number): number;
  lua_sethook(L: FengariLuaState, func: ((L: FengariLuaState) => void) | null, mask: number, count: number): void;
  lua_isyieldable(L: FengariLuaState): boolean;
  lua_yield(L: FengariLuaState, nresults: number): unknown;
  lua_error(L: FengariLuaState): unknown;
}

/** The `fengari` module object (its default export), passed in by the caller. */
export interface FengariModule {
  lua: FengariLua;
  lauxlib: {
    luaL_newstate(): FengariLuaState;
    luaL_loadbufferx(L: FengariLuaState, buff: Uint8Array, size: number, name: Uint8Array, mode: Uint8Array): number;
  };
  lualib: {
    luaopen_base(L: FengariLuaState): number;
    luaopen_string(L: FengariLuaState): number;
    luaopen_table(L: FengariLuaState): number;
    luaopen_math(L: FengariLuaState): number;
  };
  luaconf: { LUA_MAXINTEGER: number };
  to_luastring(str: string): Uint8Array;
}

const bootstrapBytecode = new WeakMap<FengariModule, Buffer>();

/** Synchronous runner for trusted scripts. Memory is managed by the JavaScript GC. */
export function runFengari(
  fengari: FengariModule, source: Buffer, keys: Buffer[], args: Buffer[], config: Readonly<ScriptingConfig>,
  call: LuaCall | null, compileOnly = false, onCompiled: () => void = () => {},
): RespValue {
  const { lua, lauxlib, lualib, luaconf, to_luastring: bytes } = fengari;
  const deadline = performance.now() + config.timeoutMs;
  const timedOut = () => performance.now() >= deadline;
  const timeoutError = () => new Error('ERR script execution timed out');
  const state = lauxlib.luaL_newstate();
  if (!state) throw new Error('ERR unable to create Lua state');
  let thread: FengariLuaState | undefined;
  const pushBytes = (L: FengariLuaState, value: Buffer | string): void => {
    const buffer = Buffer.from(value);
    lua.lua_pushlstring(L, buffer, buffer.length);
  };
  const readBytes = (L: FengariLuaState, index: number): Buffer => Buffer.from(lua.lua_tolstring(L, index));
  const { pushReply, readReply } = createReplyCodec(lua, {
    pushBytes, readBytes, timedOut, timeoutError, integerIndex: Number, fieldName: bytes,
  });
  const json = createJsonCodec(lua, {
    pushBytes, readBytes, timedOut, timeoutError, toInteger: Number, maxInteger: luaconf.LUA_MAXINTEGER, fieldName: bytes,
  });

  function assertOk(L: FengariLuaState, status: number): void {
    if (timedOut() || status === LUA.YIELD) throw timeoutError();
    if (status === LUA.OK) return;
    const message = lua.lua_type(L, -1) === LUA.STRING ? readBytes(L, -1).toString('utf8') : 'Lua execution failed';
    throw new Error(`ERR ${cleanError(message).replace(/^ERR /, '')}`);
  }

  function load(L: FengariLuaState, source: Buffer, name: string, mode = 't'): void {
    assertOk(L, lauxlib.luaL_loadbufferx(L, source, source.length, bytes(name), bytes(mode)));
  }

  try {
    lualib.luaopen_base(state);
    lua.lua_pop(state, 1);
    for (const name of ['string', 'table', 'math'] as const) {
      lualib[`luaopen_${name}`](state);
      lua.lua_setglobal(state, bytes(name));
    }
    for (const [name, values] of [['KEYS', keys], ['ARGV', args]] as const) {
      lua.lua_createtable(state, values.length, 0);
      for (let i = 0; i < values.length; i++) {
        pushBytes(state, values[i]);
        lua.lua_rawseti(state, -2, i + 1);
      }
      lua.lua_setglobal(state, bytes(name));
    }
    lua.lua_createtable(state, 0, 4);
    lua.lua_pushcfunction(state, (L) => {
      let value: CommandReply | undefined;
      if (timedOut()) value = { error: timeoutError().message };
      else {
        const argv: Buffer[] = [];
        for (let i = 1; i <= lua.lua_gettop(L); i++) {
          const type = lua.lua_type(L, i);
          if (type !== LUA.STRING && type !== LUA.NUMBER) {
            value = { error: 'ERR Lua redis command arguments must be strings or integers' };
            break;
          }
          argv.push(readBytes(L, i));
        }
        if (!value) value = call!(argv);
      }
      pushReply(L, value);
      return 1;
    });
    lua.lua_setfield(state, -2, bytes('call'));
    lua.lua_setglobal(state, bytes('redis'));
    json.pushLibrary(state, (L, fn) => lua.lua_pushcfunction(L, fn));
    lua.lua_setglobal(state, bytes('cjson'));
    const cached = bootstrapBytecode.get(fengari);
    if (cached) load(state, cached, '@resplite', 'b');
    else {
      load(state, BOOTSTRAP, '@resplite');
      const chunks: Buffer[] = [];
      const status = lua.lua_dump(state, (_L, chunk, size) => {
        chunks.push(Buffer.from(chunk.subarray(0, size)));
        return 0;
      }, null, false);
      if (status !== LUA.OK) throw new Error('ERR unable to serialize Lua bootstrap');
      bootstrapBytecode.set(fengari, Buffer.concat(chunks));
    }
    assertOk(state, lua.lua_pcall(state, 0, 0, 0));
    thread = lua.lua_newthread(state);
    load(thread, source, '@user_script');
    onCompiled();
    if (compileOnly) return null;
    lua.lua_sethook(thread, (L) => {
      if (!timedOut()) return;
      if (lua.lua_isyieldable(L)) lua.lua_yield(L, 0);
      else {
        // Fengari cannot yield across native callbacks. This error is catchable
        // by Lua, so this adapter is only suitable for trusted code.
        pushBytes(L, timeoutError().message);
        lua.lua_error(L);
      }
    }, lua.LUA_MASKCOUNT, INSTRUCTION_CHECK_INTERVAL);
    assertOk(thread, lua.lua_resume(thread, null, 0));
    const count = lua.lua_gettop(thread);
    return count ? readReply(thread, -count) : null;
  } finally {
    if (thread) lua.lua_sethook(thread, null, 0, 0);
    lua.lua_close(state);
  }
}
