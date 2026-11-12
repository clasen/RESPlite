/**
 * HTTL key FIELDS numfields field [field ...]
 * Returns array of seconds per field: -2 (missing), -1 (no TTL), else remaining seconds.
 */

import { commandError, parseHashFields } from './hash-field-expiration.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleHttl(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 4) {
    return { error: "ERR wrong number of arguments for 'HTTL' command" };
  }
  const key = args[0];
  const parsed = parseHashFields(args, 1);
  if (parsed.error) return parsed;
  try {
    return engine.httl(key, parsed.fields);
  } catch (error) {
    return commandError(error);
  }
}
