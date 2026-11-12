import { scriptingConfig, FENGARI_DEFAULTS } from './config.ts';
import { createScriptingPlugin } from './plugin.ts';
import { runLua } from './runtime.ts';
import { runFengari } from './fengari-runtime.ts';
import type { ScriptingPlugin } from './plugin.ts';
import type { WasmoonEmscriptenModule, WasmoonLuaModule } from './runtime.ts';
import type { FengariModule } from './fengari-runtime.ts';

export type { ScriptingPlugin, WasmoonLuaModule, FengariModule };

/** Scripting limits. Every value must be a positive safe integer. */
export interface ScriptingOptions {
  /** Execution budget in milliseconds, checked during Lua instructions and between commands. Default 1,000. */
  timeoutMs?: number;
  /** Maximum size of an individual script source in bytes. Default 256 KiB. */
  maxScriptBytes?: number;
  /** Maximum number of cached script sources. Default 256. */
  maxCachedScripts?: number;
  /** Maximum total bytes of cached script sources. Default 4 MiB. */
  maxCacheBytes?: number;
}

/** Wasmoon scripting limits. */
export interface WasmoonScriptingOptions extends ScriptingOptions {
  /** Maximum Lua state allocations in bytes. Default 16 MiB. */
  maxMemoryBytes?: number;
}

type RawStringExports = '_lua_pushlstring' | '_lua_tolstring';

/**
 * Wasmoon's published types omit the raw string exports the runner calls, so
 * they are optional here and checked at runtime.
 */
export type WasmoonLuaModuleInput = Omit<WasmoonLuaModule, 'module'> & {
  module: Omit<WasmoonEmscriptenModule, RawStringExports> & Partial<Pick<WasmoonEmscriptenModule, RawStringExports>>;
};

function hasRawStringExports(luaModule: WasmoonLuaModuleInput): luaModule is WasmoonLuaModule {
  return typeof luaModule?.module?._lua_tolstring === 'function'
    && typeof luaModule.module._lua_pushlstring === 'function';
}

/** Create a single-server plugin from an initialized Wasmoon LuaModule. */
export function createWasmoonScripting(luaModule: WasmoonLuaModuleInput, options: WasmoonScriptingOptions = {}): ScriptingPlugin {
  if (typeof luaModule?.lua_newstate !== 'function' || !hasRawStringExports(luaModule)) {
    throw new TypeError('Expected an initialized Wasmoon LuaModule');
  }
  const config = scriptingConfig(options);
  return createScriptingPlugin((source, keys, args, call, compileOnly, onCompiled) =>
    runLua(luaModule, source, keys, args, config, call, compileOnly, onCompiled), config);
}

/** Stable adapter for trusted scripts; Fengari has no per-state memory limit. */
export function createFengariScripting(fengari: FengariModule, options: ScriptingOptions = {}): ScriptingPlugin {
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
