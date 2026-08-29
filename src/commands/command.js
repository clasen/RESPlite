/**
 * COMMAND - introspection: list commands, count, or info for specific commands.
 * Reply format compatible with Redis COMMAND (array of [name, arity, flags, firstKey, lastKey, step, acl_categories]).
 */

/** @type {Set<string>} Commands that modify data (write). */
const WRITE_COMMANDS = new Set([
  'SET', 'SETEX', 'MSET', 'MSETNX', 'DEL', 'UNLINK', 'FLUSHDB', 'FLUSHALL', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'INCR', 'DECR', 'INCRBY', 'DECRBY',
  'HSET', 'HSETNX', 'HMSET', 'HDEL', 'HINCRBY', 'HINCRBYFLOAT',
  'HEXPIRE', 'HPEXPIRE', 'HEXPIREAT', 'HPEXPIREAT', 'HPERSIST',
  'SADD', 'SREM', 'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LREM', 'LMPOP', 'ZADD', 'ZREM', 'ZMPOP',
  'FT.CREATE', 'FT.ADD', 'FT.DEL', 'FT.SUGADD', 'FT.SUGDEL', 'CLIENT',
]);

const PUBSUB_COMMANDS = new Set([
  'PUBLISH', 'SUBSCRIBE', 'UNSUBSCRIBE', 'PSUBSCRIBE', 'PUNSUBSCRIBE', 'PUBSUB',
]);

const HASH_ARITIES = new Map([
  ['HSET', -4],
  ['HSETNX', 4],
  ['HMSET', -4],
  ['HGET', 3],
  ['HMGET', -3],
  ['HGETALL', 2],
  ['HKEYS', 2],
  ['HVALS', 2],
  ['HDEL', -3],
  ['HLEN', 2],
  ['HEXISTS', 3],
  ['HINCRBY', 4],
  ['HINCRBYFLOAT', 4],
  ['HSTRLEN', 3],
  ['HSCAN', -3],
  ['HRANDFIELD', -2],
  ['HEXPIRE', -6],
  ['HPEXPIRE', -6],
  ['HEXPIREAT', -6],
  ['HPEXPIREAT', -6],
  ['HTTL', -5],
  ['HPTTL', -5],
  ['HEXPIRETIME', -5],
  ['HPEXPIRETIME', -5],
  ['HPERSIST', -5],
]);

/**
 * Build Redis-style command doc: [name, arity, flags, firstKey, lastKey, step, acl_categories].
 * @param {string} name - Command name (lowercase for reply).
 * @returns {Array<string|number|string[]>}
 */
function docFor(name, canonicalName = name) {
  const lower = name.toLowerCase();
  const flags = PUBSUB_COMMANDS.has(canonicalName)
    ? ['pubsub']
    : WRITE_COMMANDS.has(canonicalName) ? ['write', 'fast'] : ['readonly', 'fast'];
  let arity = 2;
  let firstKey = 1;
  let lastKey = 1;
  let step = 1;
  if (PUBSUB_COMMANDS.has(canonicalName)) {
    firstKey = 0;
    lastKey = 0;
    step = 0;
    if (canonicalName === 'PUBLISH') arity = 3;
    else if (canonicalName === 'SUBSCRIBE' || canonicalName === 'PSUBSCRIBE') arity = -2;
    else if (canonicalName === 'PUBSUB') arity = -2;
    else arity = -1;
  } else if (['MGET', 'MSET', 'DEL', 'UNLINK', 'EXISTS', 'KEYS', 'SCAN', 'PING', 'ECHO', 'QUIT', 'TYPE', 'OBJECT', 'SQLITE.INFO', 'CACHE.INFO', 'MEMORY.INFO', 'COMMAND', 'MONITOR', 'CLIENT', 'DBSIZE', 'FLUSHDB', 'FLUSHALL'].includes(canonicalName)) {
    if (['PING', 'ECHO', 'QUIT', 'COMMAND', 'MONITOR', 'DBSIZE', 'FLUSHDB', 'FLUSHALL'].includes(canonicalName)) {
      firstKey = 0;
      lastKey = 0;
      step = 0;
      if (canonicalName === 'DBSIZE') arity = 1;
      else if (canonicalName === 'FLUSHDB' || canonicalName === 'FLUSHALL') arity = -1;
      else arity = canonicalName === 'COMMAND' || canonicalName === 'PING' ? -1 : (canonicalName === 'ECHO' ? 2 : 1);
    } else if (['MGET', 'EXISTS', 'KEYS', 'SCAN'].includes(canonicalName)) {
      arity = -2;
      lastKey = -1;
    } else if (canonicalName === 'MSET' || canonicalName === 'MSETNX') {
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
  } else if (HASH_ARITIES.has(canonicalName)) {
    arity = HASH_ARITIES.get(canonicalName);
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
