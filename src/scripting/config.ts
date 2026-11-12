/** Resource limits shared by every scripting adapter. */
export interface ScriptingConfig {
  timeoutMs: number;
  maxScriptBytes: number;
  maxCachedScripts: number;
  maxCacheBytes: number;
}

/** Limits of the Wasmoon adapter, which also caps Lua state memory. */
export interface WasmoonScriptingConfig extends ScriptingConfig {
  maxMemoryBytes: number;
}

export const DEFAULTS: Readonly<WasmoonScriptingConfig> = Object.freeze({
  timeoutMs: 1000,
  maxMemoryBytes: 16 * 1024 * 1024,
  maxScriptBytes: 256 * 1024,
  maxCachedScripts: 256,
  maxCacheBytes: 4 * 1024 * 1024,
});

export const INSTRUCTION_CHECK_INTERVAL = 1000;
export const MAX_REPLY_DEPTH = 128;
export const MAX_JSON_DEPTH = 1000;

const { maxMemoryBytes, ...fengariDefaults } = DEFAULTS;
export const FENGARI_DEFAULTS: Readonly<ScriptingConfig> = Object.freeze(fengariDefaults);

export function scriptingConfig(options: Partial<WasmoonScriptingConfig>): Readonly<WasmoonScriptingConfig>;
export function scriptingConfig<T extends ScriptingConfig>(options: Partial<T>, defaults: Readonly<T>): Readonly<T>;
export function scriptingConfig(
  options: Partial<ScriptingConfig>,
  defaults: Readonly<ScriptingConfig> = DEFAULTS,
): Readonly<ScriptingConfig> {
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(defaults, key)) throw new TypeError(`Unknown scripting option: ${key}`);
  }
  const config = { ...defaults, ...options };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`scripting.${key} must be a positive safe integer`);
    }
  }
  return Object.freeze(config);
}
