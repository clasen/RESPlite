/**
 * DBSIZE - returns the number of logical keys in the single database.
 */

export function handleDbsize(engine, args) {
  if (args && args.length !== 0) {
    return { error: 'ERR wrong number of arguments for \'DBSIZE\' command' };
  }
  return engine.dbsize();
}
