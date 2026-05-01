/**
 * COMMAND - introspection: list commands, count, or info for specific commands.
 * Reply format compatible with Redis COMMAND (array of [name, arity, flags, firstKey, lastKey, step, acl_categories]).
 */

/** @type {Set<string>} Commands that modify data (write). */
const WRITE_COMMANDS = new Set([
  'SET', 'SETEX', 'MSET', 'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'INCR', 'DECR', 'INCRBY', 'DECRBY',
  'HSET', 'HDEL', 'HINCRBY', 'SADD', 'SREM', 'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LREM', 'ZADD', 'ZREM',
  'FT.CREATE', 'FT.ADD', 'FT.DEL', 'FT.SUGADD', 'FT.SUGDEL', 'CLIENT',
]);

/**
 * Build Redis-style command doc: [name, arity, flags, firstKey, lastKey, step, acl_categories].
 * @param {string} name - Command name (lowercase for reply).
 * @returns {Array<string|number|string[]>}
 */
function docFor(name, canonicalName = name) {
  const lower = name.toLowerCase();
  const flags = WRITE_COMMANDS.has(canonicalName) ? ['write', 'fast'] : ['readonly', 'fast'];
  let arity = 2;
  let firstKey = 1;
  let lastKey = 1;
  let step = 1;
  if (['MGET', 'MSET', 'DEL', 'UNLINK', 'EXISTS', 'KEYS', 'SCAN', 'PING', 'ECHO', 'QUIT', 'TYPE', 'OBJECT', 'SQLITE.INFO', 'CACHE.INFO', 'MEMORY.INFO', 'COMMAND', 'MONITOR', 'CLIENT'].includes(canonicalName)) {
    if (['PING', 'ECHO', 'QUIT', 'COMMAND', 'MONITOR'].includes(canonicalName)) {
      firstKey = 0;
      lastKey = 0;
      step = 0;
      arity = canonicalName === 'COMMAND' ? -1 : (canonicalName === 'ECHO' ? 2 : 1);
    } else if (['MGET', 'EXISTS', 'KEYS', 'SCAN'].includes(canonicalName)) {
      arity = -2;
      lastKey = -1;
    } else if (canonicalName === 'MSET') {
      arity = -3;
      lastKey = -1;
      step = 2;
    } else if (['DEL', 'UNLINK'].includes(canonicalName)) {
      arity = -2;
      lastKey = -1;
    }
  } else if (canonicalName.startsWith('FT.') || canonicalName.startsWith('SQLITE.') || canonicalName.startsWith('CACHE.') || canonicalName.startsWith('MEMORY.')) {
    firstKey = 0;
    lastKey = 0;
    step = 0;
    arity = -2;
  } else if (['BLPOP', 'BRPOP'].includes(canonicalName)) {
    arity = -3;
    lastKey = -1;
    step = 1;
  } else if (['HMGET', 'HGETALL', 'HGET', 'HSET', 'HDEL', 'HEXISTS', 'HINCRBY', 'HLEN'].includes(canonicalName)) {
    arity = (canonicalName === 'HGET' || canonicalName === 'HLEN' || canonicalName === 'HEXISTS') ? 3 : -3;
  } else if (canonicalName === 'SETEX') {
    arity = 4;
  }
  return [lower, arity, flags, firstKey, lastKey, step, []];
}

/**
 * @param {object} engine
 * @param {Buffer[]} args - subcommand and optional names for INFO
 * @param {{ getCommandNames?: () => string[] }} context
 */
export function handleCommand(engine, args, context) {
  const allNames = context?.getCommandNames ? context.getCommandNames() : [];
  const resolveCanonical = context?.resolveCommandForIntrospection
    ? (name) => context.resolveCommandForIntrospection(name)
    : (name) => name;
  const sub = (args && args.length > 0 && Buffer.isBuffer(args[0])) ? args[0].toString('utf8').toUpperCase() : '';

  if (!sub || sub === '') {
    const reply = allNames.map((n) => docFor(n, resolveCanonical(n)));
    return reply;
  }
  if (sub === 'COUNT') {
    return allNames.length;
  }
  if (sub === 'INFO') {
    const names = (args.slice(1) || []).map((b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b)).toUpperCase());
    const set = new Set(allNames);
    const reply = names.map((n) => set.has(n) ? docFor(n, resolveCanonical(n)) : null).filter((x) => x != null);
    return reply;
  }

  return { error: 'ERR unknown subcommand or wrong number of arguments for \'COMMAND\'. Try COMMAND HELP.' };
}
