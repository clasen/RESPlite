import { commandError } from './hash-field-expiration.js';

const INTEGER = /^-?\d+$/;

export function handleHrandfield(engine, args) {
  if (!args || args.length < 1 || args.length > 3) {
    return { error: "ERR wrong number of arguments for 'HRANDFIELD' command" };
  }

  let count = null;
  let withValues = false;
  if (args.length >= 2) {
    const countText = args[1].toString('utf8');
    if (!INTEGER.test(countText)) return { error: 'ERR value is not an integer or out of range' };
    count = Number(countText);
    if (!Number.isSafeInteger(count)) return { error: 'ERR value is not an integer or out of range' };
  }
  if (args.length === 3) {
    if (args[2].toString('utf8').toUpperCase() !== 'WITHVALUES') return { error: 'ERR syntax error' };
    withValues = true;
  }

  try {
    return engine.hrandfield(args[0], count, { withValues });
  } catch (error) {
    return commandError(error);
  }
}
