import { commandError, parseHashFields } from './hash-field-expiration.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleHpttl(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 4) {
    return { error: "ERR wrong number of arguments for 'HPTTL' command" };
  }
  const parsed = parseHashFields(args, 1);
  if (parsed.error) return parsed;
  try {
    return engine.hpttl(args[0], parsed.fields);
  } catch (error) {
    return commandError(error);
  }
}
