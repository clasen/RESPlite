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
function docFor(name) {
  const lower = name.toLowerCase();
  const flags = WRITE_COMMANDS.has(name) ? ['write', 'fast'] : ['readonly', 'fast'];
  let arity = 2;
  let firstKey = 1;
  let lastKey = 1;
  let step = 1;
  if (['MGET', 'MSET', 'DEL', 'UNLINK', 'EXISTS', 'KEYS', 'SCAN', 'PING', 'ECHO', 'QUIT', 'TYPE', 'OBJECT', 'SQLITE.INFO', 'CACHE.INFO', 'MEMORY.INFO', 'COMMAND', 'MONITOR', 'CLIENT'].includes(name)) {
    if (['PING', 'ECHO', 'QUIT', 'COMMAND', 'MONITOR'].includes(name)) {
      firstKey = 0;
      lastKey = 0;
      step = 0;
      arity = name === 'COMMAND' ? -1 : (name === 'ECHO' ? 2 : 1);
    } else if (['MGET', 'EXISTS', 'KEYS', 'SCAN'].includes(name)) {
      arity = -2;
      lastKey = -1;
    } else if (name === 'MSET') {
      arity = -3;
      lastKey = -1;
      step = 2;
    } else if (['DEL', 'UNLINK'].includes(name)) {
      arity = -2;
      lastKey = -1;
    }
  } else if (name.startsWith('FT.') || name.startsWith('SQLITE.') || name.startsWith('CACHE.') || name.startsWith('MEMORY.')) {
    firstKey = 0;
    lastKey = 0;
    step = 0;
    arity = -2;
  } else if (['BLPOP', 'BRPOP'].includes(name)) {
    arity = -3;
    lastKey = -1;
    step = 1;
  } else if (['HMGET', 'HGETALL', 'HGET', 'HSET', 'HDEL', 'HEXISTS', 'HINCRBY', 'HLEN'].includes(name)) {
    arity = (name === 'HGET' || name === 'HLEN' || name === 'HEXISTS') ? 3 : -3;
  } else if (name === 'SETEX') {
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
  const sub = (args && args.length > 0 && Buffer.isBuffer(args[0])) ? args[0].toString('utf8').toUpperCase() : '';

  if (!sub || sub === '') {
    const reply = allNames.map((n) => docFor(n));
    return reply;
  }
  if (sub === 'COUNT') {
    return allNames.length;
  }
  if (sub === 'INFO') {
    const names = (args.slice(1) || []).map((b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b)).toUpperCase());
    const set = new Set(allNames);
    const reply = names.map((n) => set.has(n) ? docFor(n) : null).filter((x) => x != null);
    return reply;
  }

  return { error: 'ERR unknown subcommand or wrong number of arguments for \'COMMAND\'. Try COMMAND HELP.' };
}
