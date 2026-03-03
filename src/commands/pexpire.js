/**
 * PEXPIRE key milliseconds - set TTL in milliseconds.
 */

export function handlePexpire(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'PEXPIRE\' command' };
  }
  const ms = parseInt(args[1].toString(), 10);
  if (Number.isNaN(ms)) return { error: 'ERR value is not an integer or out of range' };
  const ok = engine.pexpire(args[0], ms);
  return ok ? 1 : 0;
}
