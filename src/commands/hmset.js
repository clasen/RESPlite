import { commandError } from './hash-field-expiration.js';

export function handleHmset(engine, args) {
  if (!args || args.length < 3 || args.length % 2 !== 1) {
    return { error: "ERR wrong number of arguments for 'HMSET' command" };
  }
  try {
    engine.hset(args[0], ...args.slice(1));
    return { simple: 'OK' };
  } catch (error) {
    return commandError(error);
  }
}
