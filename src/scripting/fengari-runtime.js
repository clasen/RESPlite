import { performance } from 'node:perf_hooks';
import { INSTRUCTION_CHECK_INTERVAL } from './config.js';
import { LUA, BOOTSTRAP, cleanError, createReplyCodec } from './lua-common.js';

const bootstrapBytecode = new WeakMap();

/** Experimental synchronous runner. Memory is managed by the JavaScript GC. */
export function runFengari(fengari, source, keys, args, config, call, compileOnly = false, onCompiled = () => {}) {
  const { lua, lauxlib, lualib, to_luastring: bytes } = fengari;
  const deadline = performance.now() + config.timeoutMs;
  const timedOut = () => performance.now() >= deadline;
  const timeoutError = () => new Error('ERR script execution timed out');
  const state = lauxlib.luaL_newstate();
  if (!state) throw new Error('ERR unable to create Lua state');
  let thread;
  const pushBytes = (L, value) => {
    const buffer = Buffer.from(value);
    lua.lua_pushlstring(L, buffer, buffer.length);
  };
  const readBytes = (L, index) => Buffer.from(lua.lua_tolstring(L, index));
  const { pushReply, readReply } = createReplyCodec(lua, {
    pushBytes, readBytes, timedOut, timeoutError, integerIndex: Number, fieldName: bytes,
  });

  function assertOk(L, status) {
    if (timedOut() || status === LUA.YIELD) throw timeoutError();
    if (status === LUA.OK) return;
    const message = lua.lua_type(L, -1) === LUA.STRING ? readBytes(L, -1).toString('utf8') : 'Lua execution failed';
    throw new Error(`ERR ${cleanError(message).replace(/^ERR /, '')}`);
  }

  function load(L, source, name, mode = 't') {
    assertOk(L, lauxlib.luaL_loadbufferx(L, source, source.length, bytes(name), bytes(mode)));
  }

  try {
    lualib.luaopen_base(state);
    lua.lua_pop(state, 1);
    for (const name of ['string', 'table', 'math']) {
      lualib[`luaopen_${name}`](state);
      lua.lua_setglobal(state, bytes(name));
    }
    for (const [name, values] of [['KEYS', keys], ['ARGV', args]]) {
      lua.lua_createtable(state, values.length, 0);
      for (let i = 0; i < values.length; i++) {
        pushBytes(state, values[i]);
        lua.lua_rawseti(state, -2, i + 1);
      }
      lua.lua_setglobal(state, bytes(name));
    }
    lua.lua_createtable(state, 0, 4);
    lua.lua_pushcfunction(state, (L) => {
      let value;
      if (timedOut()) value = { error: timeoutError().message };
      else {
        const argv = [];
        for (let i = 1; i <= lua.lua_gettop(L); i++) {
          const type = lua.lua_type(L, i);
          if (type !== LUA.STRING && type !== LUA.NUMBER) {
            value = { error: 'ERR Lua redis command arguments must be strings or integers' };
            break;
          }
          argv.push(readBytes(L, i));
        }
        if (!value) value = call(argv);
      }
      pushReply(L, value);
      return 1;
    });
    lua.lua_setfield(state, -2, bytes('call'));
    lua.lua_setglobal(state, bytes('redis'));
    const cached = bootstrapBytecode.get(fengari);
    if (cached) load(state, cached, '@resplite', 'b');
    else {
      load(state, BOOTSTRAP, '@resplite');
      const chunks = [];
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
        // by Lua, so the experimental adapter is only suitable for trusted code.
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
