import { scriptingConfig, FENGARI_DEFAULTS } from './config.js';
import { createScriptingPlugin } from './plugin.js';
import { runLua } from './runtime.js';
import { runFengari } from './fengari-runtime.js';

/** Create a single-server plugin from an initialized Wasmoon LuaModule. */
export function createWasmoonScripting(luaModule, options = {}) {
  if (typeof luaModule?.lua_newstate !== 'function'
    || typeof luaModule?.module?._lua_tolstring !== 'function') {
    throw new TypeError('Expected an initialized Wasmoon LuaModule');
  }
  const config = scriptingConfig(options);
  return createScriptingPlugin((source, keys, args, call, compileOnly, onCompiled) =>
    runLua(luaModule, source, keys, args, config, call, compileOnly, onCompiled), config);
}

/** Stable adapter for trusted scripts; Fengari has no per-state memory limit. */
export function createFengariScripting(fengari, options = {}) {
  if (typeof fengari?.lua?.lua_newstate !== 'function'
    || typeof fengari?.lauxlib?.luaL_loadbufferx !== 'function'
    || typeof fengari?.to_luastring !== 'function') {
    throw new TypeError('Expected the Fengari module');
  }
  if (Object.hasOwn(options, 'maxMemoryBytes')) {
    throw new TypeError('Fengari does not support maxMemoryBytes');
  }
  const config = scriptingConfig(options, FENGARI_DEFAULTS);
  return createScriptingPlugin((source, keys, args, call, compileOnly, onCompiled) =>
    runFengari(fengari, source, keys, args, config, call, compileOnly, onCompiled), config);
}
