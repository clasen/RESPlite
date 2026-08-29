import { commandError, parseHashFields } from './hash-field-expiration.js';

export function handleHexpiretime(engine, args) {
  if (!args || args.length < 4) {
    return { error: "ERR wrong number of arguments for 'HEXPIRETIME' command" };
  }
  const parsed = parseHashFields(args, 1);
  if (parsed.error) return parsed;
  try {
    return engine.hexpiretime(args[0], parsed.fields);
  } catch (error) {
    return commandError(error);
  }
}
