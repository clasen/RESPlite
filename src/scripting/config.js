export const DEFAULTS = Object.freeze({
  timeoutMs: 1000,
  maxMemoryBytes: 16 * 1024 * 1024,
  maxScriptBytes: 256 * 1024,
  maxCachedScripts: 256,
  maxCacheBytes: 4 * 1024 * 1024,
});

export const INSTRUCTION_CHECK_INTERVAL = 1000;
export const MAX_REPLY_DEPTH = 128;

const { maxMemoryBytes, ...fengariDefaults } = DEFAULTS;
export const FENGARI_DEFAULTS = Object.freeze(fengariDefaults);

export function scriptingConfig(options, defaults = DEFAULTS) {
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
