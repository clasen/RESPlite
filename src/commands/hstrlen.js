import { commandError } from './hash-field-expiration.js';

export function handleHstrlen(engine, args) {
  if (!args || args.length !== 2) {
    return { error: "ERR wrong number of arguments for 'HSTRLEN' command" };
  }
  try {
    return engine.hstrlen(args[0], args[1]);
  } catch (error) {
    return commandError(error);
  }
}
