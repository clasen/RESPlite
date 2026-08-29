import { commandError } from './hash-field-expiration.js';

export function handleHincrbyfloat(engine, args) {
  if (!args || args.length !== 3) {
    return { error: "ERR wrong number of arguments for 'HINCRBYFLOAT' command" };
  }
  try {
    return engine.hincrbyfloat(args[0], args[1], args[2]);
  } catch (error) {
    return commandError(error);
  }
}
