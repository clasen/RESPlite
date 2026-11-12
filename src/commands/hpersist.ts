/**
 * HPERSIST key FIELDS numfields field [field ...]
 * Removes per-field TTL. Returns array: -2 (missing), -1 (no TTL), 1 (cleared).
 */

import { commandError, parseHashFields } from './hash-field-expiration.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleHpersist(engine: Engine, args: Buffer[]): CommandReply {
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
