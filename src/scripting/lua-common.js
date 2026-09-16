import { MAX_REPLY_DEPTH } from './config.js';

export const LUA = { OK: 0, YIELD: 1, NIL: 0, BOOLEAN: 1, NUMBER: 3, STRING: 4, TABLE: 5, COUNT: 8 };
export const BOOTSTRAP = Buffer.from(`
local keep = {
  _VERSION=true, assert=true, error=true, ipairs=true, next=true, pairs=true,
  pcall=true, select=true, tonumber=true, tostring=true, type=true, xpcall=true,
  string=true, table=true, math=true, KEYS=true, ARGV=true, redis=true
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
`);

export function cleanError(message) {
  return String(message).replace(/[\r\n]/g, ' ');
}

export function createReplyCodec(lua, { pushBytes, readBytes, timedOut, timeoutError, integerIndex = BigInt, fieldName = (name) => name }) {
  function pushReply(L, value) {
    if (value === null) lua.lua_pushboolean(L, 0);
    else if (typeof value === 'number') lua.lua_pushnumber(L, value);
    else if (Buffer.isBuffer(value) || typeof value === 'string') pushBytes(L, value);
    else if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      for (let i = 0; i < value.length; i++) {
        pushReply(L, value[i]);
        lua.lua_rawseti(L, -2, integerIndex(i + 1));
      }
    } else if (value && (value.error !== undefined || value.simple !== undefined)) {
      lua.lua_createtable(L, 0, 1);
      pushBytes(L, cleanError(value.error ?? value.simple));
      lua.lua_setfield(L, -2, fieldName(value.error !== undefined ? 'err' : 'ok'));
    } else {
      throw new TypeError('ERR unsupported command reply in script');
    }
  }

  function readReply(L, index, seen = new Set()) {
    if (timedOut()) throw timeoutError();
    if (!lua.lua_checkstack(L, 4)) throw new Error('ERR Lua reply stack exhausted');
    index = lua.lua_absindex(L, index);
    switch (lua.lua_type(L, index)) {
      case LUA.NIL: return null;
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
        for (const [field, tag] of [['err', 'error'], ['ok', 'simple']]) {
          pushBytes(L, field);
          lua.lua_rawget(L, index);
          const value = lua.lua_type(L, -1) === LUA.STRING ? readBytes(L, -1) : null;
          lua.lua_pop(L, 1);
          if (value !== null) return { [tag]: cleanError(value.toString('utf8')) };
        }
        seen.add(pointer);
        const result = [];
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
