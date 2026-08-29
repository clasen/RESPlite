const CONDITIONS = new Set(['NX', 'XX', 'GT', 'LT']);
const INTEGER_PATTERN = /^-?\d+$/;

function text(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

export function commandError(error) {
  const message = error && error.message ? error.message : String(error);
  return { error: message.startsWith('ERR ') || message.startsWith('WRONGTYPE') ? message : `ERR ${message}` };
}

export function parseHashFields(args, startIndex) {
  if (args.length <= startIndex || text(args[startIndex]).toUpperCase() !== 'FIELDS') {
    return { error: 'ERR syntax error' };
  }
  const countText = args[startIndex + 1] == null ? '' : text(args[startIndex + 1]);
  if (!INTEGER_PATTERN.test(countText)) return { error: 'ERR value is not an integer or out of range' };
  const count = Number(countText);
  if (!Number.isSafeInteger(count)) return { error: 'ERR value is not an integer or out of range' };
  if (count < 1) return { error: 'ERR numfields should be greater than 0' };
  const fields = args.slice(startIndex + 2);
  if (fields.length !== count) {
    return { error: 'ERR Parameter `numFields` should be equal to the number of arguments' };
  }
  return { fields };
}

export function handleHashExpire(engine, args, { command, absolute, milliseconds }) {
  if (!args || args.length < 5) {
    return { error: `ERR wrong number of arguments for '${command}' command` };
  }
  const timeText = text(args[1]);
  if (!INTEGER_PATTERN.test(timeText)) return { error: 'ERR value is not an integer or out of range' };
  const time = Number(timeText);
  if (!Number.isSafeInteger(time)) return { error: 'ERR value is not an integer or out of range' };

  let index = 2;
  let condition = null;
  const candidate = text(args[index]).toUpperCase();
  if (CONDITIONS.has(candidate)) {
    condition = candidate;
    index++;
  }

  const parsed = parseHashFields(args, index);
  if (parsed.error) return parsed;
  const durationMs = milliseconds ? time : time * 1000;
  if (!Number.isSafeInteger(durationMs)) return { error: 'ERR value is not an integer or out of range' };
  const expiresAtMs = absolute ? durationMs : engine._clock() + durationMs;
  if (!Number.isSafeInteger(expiresAtMs)) return { error: 'ERR value is not an integer or out of range' };

  try {
    return engine.hexpire(args[0], expiresAtMs, parsed.fields, { condition });
  } catch (error) {
    return commandError(error);
  }
}
