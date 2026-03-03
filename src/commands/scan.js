/**
 * SCAN cursor - minimal form; returns [nextCursor, keys].
 */

export function handleScan(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'SCAN\' command' };
  }
  const cursor = args[0].toString();
  const { cursor: next, keys } = engine.scan(cursor, { count: 10 });
  return [String(next), keys];
}
