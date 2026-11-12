import { commandError } from './hash-field-expiration.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleHstrlen(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length !== 2) {
    return { error: "ERR wrong number of arguments for 'HSTRLEN' command" };
  }
  try {
    return engine.hstrlen(args[0], args[1]);
  } catch (error) {
    return commandError(error);
  }
}
