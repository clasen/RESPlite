import { MAX_JSON_DEPTH } from './config.ts';
import { LUA } from './lua-common.ts';
import type { LuaApi, LuaCodecIo, LuaInteger, LuaName } from './lua-common.ts';

type PunctuationType = 'T_OBJ_BEGIN' | 'T_OBJ_END' | 'T_ARR_BEGIN' | 'T_ARR_END' | 'T_COLON' | 'T_COMMA';
type JsonToken =
  | { type: 'T_STRING'; index: number; value: Buffer; error?: undefined }
  | { type: 'T_NUMBER'; index: number; value: number; error?: undefined }
  | { type: 'T_BOOLEAN' | 'T_NULL'; index: number; value: boolean | null; error?: undefined }
  | { type: 'T_ERROR'; index: number; error: string }
  | { type: PunctuationType | 'T_END'; index: number; error?: undefined };
type JsonChunk = string | Buffer;

interface JsonCodecOptions<State> extends LuaCodecIo<State> {
  toInteger?: (n: number) => LuaInteger;
  maxInteger?: number;
  fieldName?: (name: string) => LuaName;
}

// lua-cjson defaults used by Redis: arrays may have holes unless they are sparse.
const SPARSE_RATIO = 2;
const SPARSE_SAFE = 10;
const TYPE_NAMES = ['nil', 'boolean', 'userdata', 'number', 'string', 'table', 'function', 'userdata', 'thread'];
const ESCAPES = Array.from({ length: 256 }, (_, byte) => {
  if (byte < 0x20) return ({ 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' } as Record<number, string>)[byte] ?? `\\u${byte.toString(16).padStart(4, '0')}`;
  return ({ 0x22: '\\"', 0x2f: '\\/', 0x5c: '\\\\', 0x7f: '\\u007f' } as Record<number, string>)[byte] ?? null;
});
const SIMPLE_ESCAPES = new Map(Object.entries({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })
  .map(([escape, value]) => [escape, Buffer.from(value)]));
const PUNCTUATION: Record<string, PunctuationType> = { '{': 'T_OBJ_BEGIN', '}': 'T_OBJ_END', '[': 'T_ARR_BEGIN', ']': 'T_ARR_END', ':': 'T_COLON', ',': 'T_COMMA' };
const LITERALS: [string, 'T_BOOLEAN' | 'T_NULL', boolean | null][] = [['true', 'T_BOOLEAN', true], ['false', 'T_BOOLEAN', false], ['null', 'T_NULL', null]];
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX4 = /[0-9a-fA-F]{4}/y;

class JsonError extends Error {}

const trimZeros = (text: string): string => text.includes('.') ? text.replace(/\.?0+$/, '') : text;

/** Formats like C printf("%.14g"), as lua-cjson does. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new JsonError('Cannot serialise number: must not be NaN or Inf');
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const [mantissa, exponentText] = value.toExponential(13).split('e');
  const exponent = Number(exponentText);
  if (exponent >= -4 && exponent < 14) return trimZeros(value.toFixed(13 - exponent));
  return `${trimZeros(mantissa)}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

function pushString(out: JsonChunk[], bytes: Buffer): void {
  out.push('"');
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    const escape = ESCAPES[bytes[i]];
    if (!escape) continue;
    if (i > start) out.push(bytes.subarray(start, i));
    out.push(escape);
    start = i + 1;
  }
  if (start < bytes.length) out.push(bytes.subarray(start));
  out.push('"');
}

/** Redis-compatible cjson.encode/decode/null, shared by both Lua runtimes. */
export function createJsonCodec<State>(lua: LuaApi<State>, {
  pushBytes, readBytes, timedOut, timeoutError, toInteger = BigInt, maxInteger = Number.MAX_SAFE_INTEGER, fieldName = (name: string) => name,
}: JsonCodecOptions<State>) {
  function checkTimeout(): void {
    if (timedOut()) throw new JsonError(timeoutError().message);
  }

  function arrayLength(L: State, index: number): number {
    let max = 0;
    let items = 0;
    lua.lua_pushnil(L);
    while (lua.lua_next(L, index)) {
      const key = lua.lua_type(L, -2) === LUA.NUMBER ? lua.lua_tonumberx(L, -2, 0) : 0;
      if (!Number.isInteger(key) || key < 1) {
        lua.lua_pop(L, 2);
        return 0;
      }
      lua.lua_pop(L, 1);
      max = Math.max(max, key);
      items++;
    }
    if (max > items * SPARSE_RATIO && max > SPARSE_SAFE) throw new JsonError('Cannot serialise table: excessively sparse array');
    return max;
  }

  function encodeTable(L: State, index: number, depth: number, out: JsonChunk[]): void {
    if (depth > MAX_JSON_DEPTH || !lua.lua_checkstack(L, 3)) throw new JsonError(`Cannot serialise, excessive nesting (${depth})`);
    const length = arrayLength(L, index);
    if (length > 0) {
      out.push('[');
      for (let i = 1; i <= length; i++) {
        if (i > 1) out.push(',');
        lua.lua_rawgeti(L, index, toInteger(i));
        encodeValue(L, lua.lua_gettop(L), depth, out);
        lua.lua_pop(L, 1);
      }
      out.push(']');
      return;
    }
    out.push('{');
    let first = true;
    lua.lua_pushnil(L);
    while (lua.lua_next(L, index)) {
      if (!first) out.push(',');
      first = false;
      const keyType = lua.lua_type(L, -2);
      if (keyType === LUA.NUMBER) out.push(`"${formatNumber(lua.lua_tonumberx(L, -2, 0))}"`);
      else if (keyType === LUA.STRING) pushString(out, readBytes(L, -2));
      else throw new JsonError(`Cannot serialise ${TYPE_NAMES[keyType]}: table key must be a number or string`);
      out.push(':');
      encodeValue(L, lua.lua_gettop(L), depth, out);
      lua.lua_pop(L, 1);
    }
    out.push('}');
  }

  function encodeValue(L: State, index: number, depth: number, out: JsonChunk[]): void {
    checkTimeout();
    const type = lua.lua_type(L, index);
    switch (type) {
      case LUA.NIL:
      case LUA.LIGHTUSERDATA: out.push('null'); return;
      case LUA.BOOLEAN: out.push(lua.lua_toboolean(L, index) ? 'true' : 'false'); return;
      case LUA.NUMBER: out.push(formatNumber(lua.lua_tonumberx(L, index, 0))); return;
      case LUA.STRING: pushString(out, readBytes(L, index)); return;
      case LUA.TABLE: encodeTable(L, index, depth + 1, out); return;
      default: throw new JsonError(`Cannot serialise ${TYPE_NAMES[type]}: type not supported`);
    }
  }

  function decodeJson(L: State, bytes: Buffer): void {
    const text = bytes.toString('latin1');
    let position = 0;

    const fail: (expected: string, token: JsonToken) => never = (expected, token) => {
      throw new JsonError(`Expected ${expected} but found ${token.error ?? token.type} at character ${token.index + 1}`);
    };

    function hexAt(offset: number): number {
      if (text[offset] !== '\\' || text[offset + 1] !== 'u') return -1;
      HEX4.lastIndex = offset + 2;
      return HEX4.test(text) ? parseInt(text.slice(offset + 2, offset + 6), 16) : -1;
    }

    function readUnicode(offset: number): { bytes: Buffer; end: number } | null {
      let code = hexAt(offset);
      let end = offset + 6;
      if (code < 0 || (code >= 0xdc00 && code <= 0xdfff)) return null;
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = hexAt(end);
        if (low < 0xdc00 || low > 0xdfff) return null;
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        end += 6;
      }
      return { bytes: Buffer.from(String.fromCodePoint(code)), end };
    }

    function readString(index: number): JsonToken {
      const parts: Buffer[] = [];
      let start = index + 1;
      for (let i = start; i < bytes.length; i++) {
        if (bytes[i] === 0x22) {
          parts.push(bytes.subarray(start, i));
          position = i + 1;
          return { type: 'T_STRING', index, value: Buffer.concat(parts) };
        }
        if (bytes[i] !== 0x5c) continue;
        parts.push(bytes.subarray(start, i));
        const escape = text[i + 1];
        if (escape === 'u') {
          const decoded = readUnicode(i);
          if (!decoded) return { type: 'T_ERROR', index: i, error: 'invalid unicode escape code' };
          parts.push(decoded.bytes);
          i = decoded.end - 1;
        } else if (SIMPLE_ESCAPES.has(escape)) {
          parts.push(SIMPLE_ESCAPES.get(escape)!);
          i++;
        } else {
          return { type: 'T_ERROR', index: i, error: 'invalid escape code' };
        }
        start = i + 1;
      }
      return { type: 'T_ERROR', index: bytes.length, error: 'unexpected end of string' };
    }

    function nextToken(): JsonToken {
      while (position < text.length && ' \t\n\r'.includes(text[position])) position++;
      const index = position;
      if (index >= text.length) return { type: 'T_END', index };
      const char = text[index];
      if (Object.hasOwn(PUNCTUATION, char)) {
        position++;
        return { type: PUNCTUATION[char], index };
      }
      if (char === '"') return readString(index);
      if (char === '-' || (char >= '0' && char <= '9')) {
        NUMBER.lastIndex = index;
        const match = NUMBER.exec(text);
        if (!match) return { type: 'T_ERROR', index, error: 'invalid number' };
        position = NUMBER.lastIndex;
        return { type: 'T_NUMBER', index, value: Number(match[0]) };
      }
      for (const [word, type, value] of LITERALS) {
        if (!text.startsWith(word, index)) continue;
        position += word.length;
        return { type, index, value };
      }
      return { type: 'T_ERROR', index, error: 'invalid token' };
    }

    function descend(token: JsonToken, depth: number): void {
      if (depth > MAX_JSON_DEPTH || !lua.lua_checkstack(L, 3)) {
        throw new JsonError(`Found too many nested data structures (${depth}) at character ${token.index + 1}`);
      }
      lua.lua_createtable(L, 0, 0);
    }

    function parseObject(token: JsonToken, depth: number): void {
      descend(token, depth);
      token = nextToken();
      if (token.type === 'T_OBJ_END') return;
      for (;;) {
        if (token.type !== 'T_STRING') fail('object key string', token);
        pushBytes(L, token.value);
        token = nextToken();
        if (token.type !== 'T_COLON') fail('colon', token);
        parseValue(nextToken(), depth);
        lua.lua_rawset(L, -3);
        token = nextToken();
        if (token.type === 'T_OBJ_END') return;
        if (token.type !== 'T_COMMA') fail('comma or object end', token);
        token = nextToken();
      }
    }

    function parseArray(token: JsonToken, depth: number): void {
      descend(token, depth);
      token = nextToken();
      if (token.type === 'T_ARR_END') return;
      for (let i = 1; ; i++) {
        parseValue(token, depth);
        lua.lua_rawseti(L, -2, toInteger(i));
        token = nextToken();
        if (token.type === 'T_ARR_END') return;
        if (token.type !== 'T_COMMA') fail('comma or array end', token);
        token = nextToken();
      }
    }

    function parseValue(token: JsonToken, depth: number): void {
      checkTimeout();
      switch (token.type) {
        case 'T_STRING': pushBytes(L, token.value); return;
        case 'T_NUMBER':
          if (Number.isInteger(token.value) && Math.abs(token.value) <= maxInteger) lua.lua_pushinteger(L, toInteger(token.value));
          else lua.lua_pushnumber(L, token.value);
          return;
        case 'T_BOOLEAN': lua.lua_pushboolean(L, token.value ? 1 : 0); return;
        case 'T_NULL': lua.lua_pushlightuserdata(L, null); return;
        case 'T_OBJ_BEGIN': parseObject(token, depth + 1); return;
        case 'T_ARR_BEGIN': parseArray(token, depth + 1); return;
        default: fail('value', token);
      }
    }

    parseValue(nextToken(), 0);
    const end = nextToken();
    if (end.type !== 'T_END') fail('the end', end);
  }

  // Native functions return (ok, value); the bootstrap raises Lua errors so no
  // error unwinds through a JavaScript frame.
  function invoke(L: State, name: string, run: () => void): number {
    try {
      if (lua.lua_gettop(L) !== 1) throw new JsonError(`bad argument #1 to '${name}' (expected 1 argument)`);
      run();
    } catch (error) {
      if (!(error instanceof JsonError)) throw error;
      lua.lua_settop(L, 0);
      lua.lua_pushboolean(L, 0);
      pushBytes(L, error.message);
    }
    return 2;
  }

  const encode = (L: State): number => invoke(L, 'encode', () => {
    const out: JsonChunk[] = [];
    encodeValue(L, 1, 0, out);
    lua.lua_settop(L, 0);
    lua.lua_pushboolean(L, 1);
    pushBytes(L, Buffer.concat(out.map((part) => typeof part === 'string' ? Buffer.from(part, 'latin1') : part)));
  });

  const decode = (L: State): number => invoke(L, 'decode', () => {
    const type = lua.lua_type(L, 1);
    if (type !== LUA.STRING && type !== LUA.NUMBER) {
      throw new JsonError(`bad argument #1 to 'decode' (string expected, got ${TYPE_NAMES[type]})`);
    }
    const bytes = readBytes(L, 1);
    lua.lua_pushboolean(L, 1);
    decodeJson(L, bytes);
  });

  /** Leaves the native cjson table on the stack. */
  function pushLibrary(L: State, pushFunction: (L: State, fn: (L: State) => number) => void): void {
    lua.lua_createtable(L, 0, 3);
    for (const [name, fn] of [['encode', encode], ['decode', decode]] as const) {
      pushFunction(L, fn);
      lua.lua_setfield(L, -2, fieldName(name));
    }
    lua.lua_pushlightuserdata(L, null);
    lua.lua_setfield(L, -2, fieldName('null'));
  }

  return { pushLibrary };
}
