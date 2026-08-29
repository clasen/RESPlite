import { commandError } from './hash-field-expiration.js';

const UNSIGNED_INTEGER = /^\d+$/;
const INTEGER = /^-?\d+$/;

function text(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

export function handleHscan(engine, args) {
  if (!args || args.length < 2) {
    return { error: "ERR wrong number of arguments for 'HSCAN' command" };
  }
  const cursorText = text(args[1]);
  if (!UNSIGNED_INTEGER.test(cursorText)) return { error: 'ERR invalid cursor' };
  const cursor = Number(cursorText);
  if (!Number.isSafeInteger(cursor)) return { error: 'ERR invalid cursor' };

  const options = {};
  for (let index = 2; index < args.length; index++) {
    const option = text(args[index]).toUpperCase();
    if (option === 'MATCH' && index + 1 < args.length) {
      options.match = args[++index];
    } else if (option === 'COUNT' && index + 1 < args.length) {
      const countText = text(args[++index]);
      if (!INTEGER.test(countText)) return { error: 'ERR value is not an integer or out of range' };
      const count = Number(countText);
      if (!Number.isSafeInteger(count)) return { error: 'ERR value is not an integer or out of range' };
      if (count < 1) return { error: 'ERR syntax error' };
      options.count = count;
    } else if (option === 'NOVALUES') {
      options.noValues = true;
    } else {
      return { error: 'ERR syntax error' };
    }
  }

  try {
    const result = engine.hscan(args[0], cursor, options);
    return [String(result.cursor), result.values];
  } catch (error) {
    return commandError(error);
  }
}
