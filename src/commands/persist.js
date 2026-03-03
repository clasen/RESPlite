/**
 * PERSIST key - remove TTL.
 */

export function handlePersist(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'PERSIST\' command' };
  }
  const ok = engine.persist(args[0]);
  return ok ? 1 : 0;
}
