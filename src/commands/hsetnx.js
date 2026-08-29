import { commandError } from './hash-field-expiration.js';

export function handleHsetnx(engine, args) {
  if (!args || args.length !== 3) {
    return { error: "ERR wrong number of arguments for 'HSETNX' command" };
  }
  try {
    return engine.hsetnx(args[0], args[1], args[2]);
  } catch (error) {
    return commandError(error);
  }
}
