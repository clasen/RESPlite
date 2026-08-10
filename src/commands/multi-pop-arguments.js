function toString(arg) {
  return Buffer.isBuffer(arg) ? arg.toString('utf8') : String(arg);
}

function parsePositiveInteger(arg, field) {
  const raw = toString(arg);
  if (!/^[+-]?\d+$/.test(raw)) {
    return { error: `ERR ${field} should be greater than 0` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { error: `ERR ${field} should be greater than 0` };
  }
  return { value };
}

export function parseMultiPopArguments(args, command, directions) {
  if (!args || args.length < 3) {
    return { error: `ERR wrong number of arguments for '${command}' command` };
  }

  const parsedNumkeys = parsePositiveInteger(args[0], 'numkeys');
  if (parsedNumkeys.error) return parsedNumkeys;
  const numkeys = parsedNumkeys.value;
  const directionIndex = numkeys + 1;
  if (directionIndex >= args.length) {
    return { error: 'ERR syntax error' };
  }

  const direction = toString(args[directionIndex]).toUpperCase();
  if (!directions.includes(direction)) {
    return { error: 'ERR syntax error' };
  }

  let count = 1;
  const remaining = args.length - directionIndex - 1;
  if (remaining !== 0) {
    if (remaining !== 2 || toString(args[directionIndex + 1]).toUpperCase() !== 'COUNT') {
      return { error: 'ERR syntax error' };
    }
    const parsedCount = parsePositiveInteger(args[directionIndex + 2], 'count');
    if (parsedCount.error) return parsedCount;
    count = parsedCount.value;
  }

  return {
    keys: args.slice(1, directionIndex),
    direction,
    count,
  };
}
