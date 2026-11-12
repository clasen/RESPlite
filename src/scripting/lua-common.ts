import { MAX_REPLY_DEPTH } from './config.ts';
import type { CommandReply, RespValue } from '../types.ts';

/** Integer argument of lua_rawseti/lua_rawgeti/lua_pushinteger: BigInt in Wasmoon, number in Fengari. */
export type LuaInteger = bigint | number;
/** Field or global name: a C string in Wasmoon, a Lua byte string in Fengari. */
export type LuaName = string | Uint8Array;

/** Lua C API members used by the reply and JSON codecs; satisfied by both runtimes. */
export interface LuaApi<State> {
  lua_absindex(L: State, idx: number): number;
  lua_checkstack(L: State, n: number): number | boolean;
  lua_createtable(L: State, narr: number, nrec: number): void;
  lua_gettop(L: State): number;
  lua_next(L: State, idx: number): number | boolean;
  lua_pop(L: State, n: number): void;
  lua_pushboolean(L: State, b: number): void;
  lua_pushinteger(L: State, n: LuaInteger): void;
  lua_pushlightuserdata(L: State, p: null): void;
  lua_pushnil(L: State): void;
  lua_pushnumber(L: State, n: number): void;
  lua_rawget(L: State, idx: number): unknown;
  lua_rawgeti(L: State, idx: number, n: LuaInteger): unknown;
  lua_rawset(L: State, idx: number): void;
  lua_rawseti(L: State, idx: number, n: LuaInteger): void;
  lua_setfield(L: State, idx: number, k: LuaName): void;
  lua_settop(L: State, idx: number): void;
  lua_toboolean(L: State, idx: number): number | boolean;
  lua_tonumberx(L: State, idx: number, isnum: number): number;
  lua_topointer(L: State, idx: number): unknown;
  lua_type(L: State, idx: number): number;
}

/** Byte transfer and deadline helpers a runtime hands to the codecs. */
export interface LuaCodecIo<State> {
  pushBytes: (L: State, value: Buffer | string) => void;
  readBytes: (L: State, index: number) => Buffer;
  timedOut: () => boolean;
  timeoutError: () => Error;
}

interface ReplyCodecOptions<State> extends LuaCodecIo<State> {
  integerIndex?: (n: number) => LuaInteger;
  fieldName?: (name: string) => LuaName;
}

type MarkedReply = { error?: string; simple?: string };

export const LUA = { OK: 0, YIELD: 1, NIL: 0, BOOLEAN: 1, LIGHTUSERDATA: 2, NUMBER: 3, STRING: 4, TABLE: 5, COUNT: 8 };
export const BOOTSTRAP = Buffer.from(`
local keep = {
  _VERSION=true, assert=true, error=true, ipairs=true, next=true, pairs=true,
  pcall=true, select=true, tonumber=true, tostring=true, type=true, xpcall=true,
  string=true, table=true, math=true, KEYS=true, ARGV=true, redis=true, cjson=true
}
local globals = _G
for name in pairs(globals) do if not keep[name] then globals[name] = nil end end
string.dump = nil
local call = redis.call
function redis.pcall(...) return call(...) end
function redis.call(...)
  local reply = call(...)
  if type(reply) == 'table' and reply.err then error(reply.err, 0) end
  return reply
end
function redis.error_reply(message)
  if type(message) ~= 'string' then error('ERR error_reply requires a string', 0) end
  return {err=message}
end
function redis.status_reply(message)
  if type(message) ~= 'string' then error('ERR status_reply requires a string', 0) end
  return {ok=message}
end
for _, name in ipairs({'encode', 'decode'}) do
  local native = cjson[name]
  cjson[name] = function(...)
    local ok, value = native(...)
    if not ok then error(value, 2) end
    return value
  end
end
`);

export function cleanError(message: unknown): string {
  return String(message).replace(/[\r\n]/g, ' ');
}

export function createReplyCodec<State>(lua: LuaApi<State>, { pushBytes, readBytes, timedOut, timeoutError, integerIndex = BigInt, fieldName = (name: string) => name }: ReplyCodecOptions<State>) {
  function pushReply(L: State, value: CommandReply | undefined): void {
    if (value === null) lua.lua_pushboolean(L, 0);
    else if (typeof value === 'number' || typeof value === 'bigint') lua.lua_pushnumber(L, Number(value));
    else if (Buffer.isBuffer(value) || typeof value === 'string') pushBytes(L, value);
    else if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      for (let i = 0; i < value.length; i++) {
        pushReply(L, value[i]);
        lua.lua_rawseti(L, -2, integerIndex(i + 1));
      }
    } else if (value && ((value as MarkedReply).error !== undefined || (value as MarkedReply).simple !== undefined)) {
      lua.lua_createtable(L, 0, 1);
      pushBytes(L, cleanError((value as MarkedReply).error ?? (value as MarkedReply).simple));
      lua.lua_setfield(L, -2, fieldName((value as MarkedReply).error !== undefined ? 'err' : 'ok'));
    } else {
      throw new TypeError('ERR unsupported command reply in script');
    }
  }

  function readReply(L: State, index: number, seen: Set<unknown> = new Set()): RespValue {
    if (timedOut()) throw timeoutError();
    if (!lua.lua_checkstack(L, 4)) throw new Error('ERR Lua reply stack exhausted');
    index = lua.lua_absindex(L, index);
    switch (lua.lua_type(L, index)) {
      case LUA.NIL:
      case LUA.LIGHTUSERDATA: return null;
      case LUA.BOOLEAN: return lua.lua_toboolean(L, index) ? 1 : null;
      case LUA.STRING: return readBytes(L, index);
      case LUA.NUMBER: {
        const value = lua.lua_tonumberx(L, index, 0);
        if (!Number.isSafeInteger(Math.trunc(value))) throw new Error('ERR script number is outside the safe integer range');
        return Math.trunc(value);
      }
      case LUA.TABLE: {
        const pointer = lua.lua_topointer(L, index);
        if (seen.has(pointer) || seen.size >= MAX_REPLY_DEPTH) {
          throw new Error('ERR cyclic or excessively nested script reply');
        }
        for (const [field, tag] of [['err', 'error'], ['ok', 'simple']] as const) {
          pushBytes(L, field);
          lua.lua_rawget(L, index);
          const value = lua.lua_type(L, -1) === LUA.STRING ? readBytes(L, -1) : null;
          lua.lua_pop(L, 1);
          if (value !== null) return { [tag]: cleanError(value.toString('utf8')) } as { error: string } | { simple: string };
        }
        seen.add(pointer);
        const result: RespValue[] = [];
        for (let i = 1; ; i++) {
          lua.lua_rawgeti(L, index, integerIndex(i));
          if (lua.lua_type(L, -1) === LUA.NIL) {
            lua.lua_pop(L, 1);
            break;
          }
          result.push(readReply(L, -1, seen));
          lua.lua_pop(L, 1);
        }
        seen.delete(pointer);
        return result;
      }
      default: throw new Error('ERR unsupported Lua result type');
    }
  }

  return { pushReply, readReply };
}
