/**
 * OBJECT subcommand key - introspection (IDLETIME: seconds since last write).
 * Only OBJECT IDLETIME key is supported; uses redis_keys.updated_at.
 */

export function handleObject(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'OBJECT\' command' };
  }
  const sub = (Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0])).toUpperCase();
  if (sub !== 'IDLETIME') {
    return { error: 'ERR unknown subcommand or wrong number of arguments for \'OBJECT\'. Try OBJECT HELP.' };
  }
  const key = args[1];
  const seconds = engine.objectIdletime(key);
  return seconds;
}
