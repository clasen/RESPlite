import { performance } from 'node:perf_hooks';
import { INSTRUCTION_CHECK_INTERVAL } from './config.js';
import { LUA, BOOTSTRAP, cleanError, createReplyCodec } from './lua-common.js';

const bootstrapBytecode = new WeakMap();

/** One isolated Lua state. All wire strings cross WASM as pointer + byte length. */
export function runLua(lua, source, keys, args, config, call, compileOnly = false, onCompiled = () => {}) {
  const wasm = lua.module;
  const deadline = performance.now() + config.timeoutMs;
  const timedOut = () => performance.now() >= deadline;
  const timeoutError = () => new Error('ERR script execution timed out');
  let used = 0;
  let enforceMemory = false;
  let state = 0;
  let thread = 0;
  const pointers = [];
  const lengthPointer = wasm._malloc(4);
  if (!lengthPointer) throw new Error('ERR unable to allocate Lua string length');

  const allocator = wasm.addFunction((_ud, pointer, oldSize, newSize) => {
    if (newSize === 0) {
      if (pointer) {
        used -= oldSize;
        wasm._free(pointer);
      }
      return 0;
    }
    const next = used + newSize - (pointer ? oldSize : 0);
    if (enforceMemory && next > config.maxMemoryBytes) return 0;
    const result = wasm._realloc(pointer, newSize);
    if (result) used = next;
    return result;
  }, 'iiiii');
  pointers.push(allocator);

  function pushBytes(L, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const pointer = wasm._malloc(Math.max(bytes.length, 1));
    if (!pointer) throw new Error('ERR unable to allocate Lua string');
    try {
      wasm.HEAPU8.set(bytes, pointer);
      wasm._lua_pushlstring(L, pointer, bytes.length);
    } finally {
      wasm._free(pointer);
    }
  }

  function readBytes(L, index) {
    const pointer = wasm._lua_tolstring(L, index, lengthPointer);
    const length = wasm.HEAPU32[lengthPointer >>> 2];
    return Buffer.from(wasm.HEAPU8.subarray(pointer, pointer + length));
  }

  const { pushReply, readReply } = createReplyCodec(lua, { pushBytes, readBytes, timedOut, timeoutError });

  function assertOk(L, status) {
    if (status === LUA.OK) return;
    if (status === LUA.YIELD || timedOut()) throw timeoutError();
    const message = lua.lua_type(L, -1) === LUA.STRING
      ? readBytes(L, -1).toString('utf8') : 'Lua execution failed';
    throw new Error(`ERR ${cleanError(message).replace(/^ERR /, '')}`);
  }

  function load(L, bytes, name, mode = 't') {
    const pointer = wasm._malloc(Math.max(bytes.length, 1));
    if (!pointer) throw new Error('ERR unable to allocate Lua source');
    try {
      wasm.HEAPU8.set(bytes, pointer);
      assertOk(L, lua.luaL_loadbufferx(L, pointer, bytes.length, name, mode));
    } finally {
      wasm._free(pointer);
    }
  }

  try {
    state = lua.lua_newstate(allocator, 0);
    if (!state) throw new Error('ERR unable to create Lua state');
    const bridge = wasm.addFunction((L) => {
      // Yielding across a JS/C command callback is not supported. The count hook
      // suspends Lua; the bridge refuses further commands once time has expired.
      let value;
      if (timedOut()) {
        value = { error: 'ERR script execution timed out' };
      } else {
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
    }, 'ii');
    pointers.push(bridge);
    const setup = wasm.addFunction((L) => {
      lua.luaopen_base(L);
      lua.lua_pop(L, 1);
      for (const name of ['string', 'table', 'math']) {
        lua[`luaopen_${name}`](L);
        lua.lua_setglobal(L, name);
      }
      for (const [name, values] of [['KEYS', keys], ['ARGV', args]]) {
        lua.lua_createtable(L, values.length, 0);
        for (let i = 0; i < values.length; i++) {
          pushBytes(L, values[i]);
          lua.lua_rawseti(L, -2, BigInt(i + 1));
        }
        lua.lua_setglobal(L, name);
      }
      lua.lua_createtable(L, 0, 4);
      lua.lua_pushcclosure(L, bridge, 0);
      lua.lua_setfield(L, -2, 'call');
      lua.lua_setglobal(L, 'redis');
      return 0;
    }, 'ii');
    pointers.push(setup);
    lua.lua_pushcclosure(state, setup, 0);
    enforceMemory = true;
    if (used > config.maxMemoryBytes) throw new Error('ERR Lua memory limit exceeded');
    assertOk(state, lua.lua_pcallk(state, 0, 0, 0, 0, 0));
    const compiledBootstrap = bootstrapBytecode.get(wasm);
    if (compiledBootstrap) {
      load(state, compiledBootstrap, '@resplite', 'b');
    } else {
      load(state, BOOTSTRAP, '@resplite');
      const chunks = [];
      const writer = wasm.addFunction((_L, pointer, size, _ud) => {
        chunks.push(Buffer.from(wasm.HEAPU8.subarray(pointer, pointer + size)));
        return 0;
      }, 'iiiii');
      pointers.push(writer);
      if (lua.lua_dump(state, writer, 0, 0) !== LUA.OK) {
        throw new Error('ERR unable to serialize Lua bootstrap');
      }
      // Only this trusted internal chunk is reused, never an executed state or user bytecode.
      bootstrapBytecode.set(wasm, Buffer.concat(chunks));
    }
    assertOk(state, lua.lua_pcallk(state, 0, 0, 0, 0, 0));

    // Create the coroutine inside a protected call so allocation failure cannot panic.
    const makeThread = wasm.addFunction((L) => {
      thread = lua.lua_newthread(L);
      return 1;
    }, 'ii');
    pointers.push(makeThread);
    enforceMemory = false;
    lua.lua_pushcclosure(state, makeThread, 0);
    enforceMemory = true;
    assertOk(state, lua.lua_pcallk(state, 0, 1, 0, 0, 0));
    load(thread, source, '@user_script');
    onCompiled();
    if (compileOnly) return null;
    if (timedOut()) throw timeoutError();
    const hook = wasm.addFunction((L) => {
      if (!timedOut()) return;
      // Native callbacks such as table.sort comparators cannot yield. A host
      // exception crosses Lua protected calls without becoming a catchable error.
      if (!lua.lua_isyieldable(L)) throw timeoutError();
      lua.lua_yieldk(L, 0, 0, 0);
    }, 'vii');
    pointers.push(hook);
    lua.lua_sethook(thread, hook, LUA.COUNT, INSTRUCTION_CHECK_INTERVAL);
    assertOk(thread, lua.lua_resume(thread, 0, 0, lengthPointer));
    if (timedOut()) throw timeoutError();
    const count = wasm.HEAPU32[lengthPointer >>> 2];
    enforceMemory = false;
    return count ? readReply(thread, -count) : null;
  } finally {
    enforceMemory = false;
    if (thread) lua.lua_sethook(thread, 0, 0, 0);
    if (state) lua.lua_close(state);
    for (const pointer of pointers) wasm.removeFunction(pointer);
    wasm._free(lengthPointer);
  }
}
