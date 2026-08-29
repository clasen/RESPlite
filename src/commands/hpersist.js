/**
 * HPERSIST key FIELDS numfields field [field ...]
 * Removes per-field TTL. Returns array: -2 (missing), -1 (no TTL), 1 (cleared).
 */

import { commandError, parseHashFields } from './hash-field-expiration.js';

export function handleHpersist(engine, args) {
  if (!args || args.length < 4) {
    return { error: "ERR wrong number of arguments for 'HPERSIST' command" };
  }
  const key = args[0];
  const parsed = parseHashFields(args, 1);
  if (parsed.error) return parsed;
  try {
    return engine.hpersist(key, parsed.fields);
  } catch (error) {
    return commandError(error);
  }
}
