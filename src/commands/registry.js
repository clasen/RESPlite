/**
 * Command registry: normalize to uppercase, route to handler, return unsupported error for unknown.
 */

import { unsupported } from '../engine/errors.js';
import * as ping from './ping.js';
import * as echo from './echo.js';
import * as quit from './quit.js';
import * as get from './get.js';
import * as set from './set.js';
import * as del from './del.js';
import * as exists from './exists.js';
import * as type from './type.js';
import * as mget from './mget.js';
import * as mset from './mset.js';
import * as expire from './expire.js';
import * as pexpire from './pexpire.js';
import * as ttl from './ttl.js';
import * as pttl from './pttl.js';
import * as persist from './persist.js';
import * as incr from './incr.js';
import * as decr from './decr.js';
import * as incrby from './incrby.js';
import * as decrby from './decrby.js';
import * as hset from './hset.js';
import * as hget from './hget.js';
import * as hmget from './hmget.js';
import * as hgetall from './hgetall.js';
import * as hdel from './hdel.js';
import * as hexists from './hexists.js';
import * as hincrby from './hincrby.js';
import * as sadd from './sadd.js';
import * as srem from './srem.js';
import * as smembers from './smembers.js';
import * as sismember from './sismember.js';
import * as scard from './scard.js';
import * as lpush from './lpush.js';
import * as rpush from './rpush.js';
import * as llen from './llen.js';
import * as lrange from './lrange.js';
import * as lindex from './lindex.js';
import * as lpop from './lpop.js';
import * as rpop from './rpop.js';
import * as blpop from './blpop.js';
import * as brpop from './brpop.js';
import * as scan from './scan.js';
import * as zadd from './zadd.js';
import * as zrem from './zrem.js';
import * as zcard from './zcard.js';
import * as zscore from './zscore.js';
import * as zrange from './zrange.js';
import * as zrangebyscore from './zrangebyscore.js';
import * as sqliteInfo from './sqlite-info.js';
import * as cacheInfo from './cache-info.js';
import * as memoryInfo from './memory-info.js';
import * as ftCreate from './ft-create.js';
import * as ftInfo from './ft-info.js';
import * as ftAdd from './ft-add.js';
import * as ftDel from './ft-del.js';
import * as ftSearch from './ft-search.js';
import * as ftSugadd from './ft-sugadd.js';
import * as ftSugget from './ft-sugget.js';
import * as ftSugdel from './ft-sugdel.js';

const HANDLERS = new Map([
  ['PING', (e, a) => ping.handlePing()],
  ['ECHO', (e, a) => echo.handleEcho(a)],
  ['QUIT', (e, a) => quit.handleQuit()],
  ['GET', (e, a) => get.handleGet(e, a)],
  ['SET', (e, a) => set.handleSet(e, a)],
  ['DEL', (e, a) => del.handleDel(e, a)],
  ['EXISTS', (e, a) => exists.handleExists(e, a)],
  ['TYPE', (e, a) => type.handleType(e, a)],
  ['MGET', (e, a) => mget.handleMget(e, a)],
  ['MSET', (e, a) => mset.handleMset(e, a)],
  ['EXPIRE', (e, a) => expire.handleExpire(e, a)],
  ['PEXPIRE', (e, a) => pexpire.handlePexpire(e, a)],
  ['TTL', (e, a) => ttl.handleTtl(e, a)],
  ['PTTL', (e, a) => pttl.handlePttl(e, a)],
  ['PERSIST', (e, a) => persist.handlePersist(e, a)],
  ['INCR', (e, a) => incr.handleIncr(e, a)],
  ['DECR', (e, a) => decr.handleDecr(e, a)],
  ['INCRBY', (e, a) => incrby.handleIncrby(e, a)],
  ['DECRBY', (e, a) => decrby.handleDecrby(e, a)],
  ['HSET', (e, a) => hset.handleHset(e, a)],
  ['HGET', (e, a) => hget.handleHget(e, a)],
  ['HMGET', (e, a) => hmget.handleHmget(e, a)],
  ['HGETALL', (e, a) => hgetall.handleHgetall(e, a)],
  ['HDEL', (e, a) => hdel.handleHdel(e, a)],
  ['HEXISTS', (e, a) => hexists.handleHexists(e, a)],
  ['HINCRBY', (e, a) => hincrby.handleHincrby(e, a)],
  ['SADD', (e, a) => sadd.handleSadd(e, a)],
  ['SREM', (e, a) => srem.handleSrem(e, a)],
  ['SMEMBERS', (e, a) => smembers.handleSmembers(e, a)],
  ['SISMEMBER', (e, a) => sismember.handleSismember(e, a)],
  ['SCARD', (e, a) => scard.handleScard(e, a)],
  ['LPUSH', (e, a) => lpush.handleLpush(e, a)],
  ['RPUSH', (e, a) => rpush.handleRpush(e, a)],
  ['LLEN', (e, a) => llen.handleLlen(e, a)],
  ['LRANGE', (e, a) => lrange.handleLrange(e, a)],
  ['LINDEX', (e, a) => lindex.handleLindex(e, a)],
  ['LPOP', (e, a, ctx) => lpop.handleLpop(e, a)],
  ['RPOP', (e, a, ctx) => rpop.handleRpop(e, a)],
  ['BLPOP', (e, a, ctx) => blpop.handleBlpop(e, a, ctx)],
  ['BRPOP', (e, a, ctx) => brpop.handleBrpop(e, a, ctx)],
  ['SCAN', (e, a) => scan.handleScan(e, a)],
  ['ZADD', (e, a) => zadd.handleZadd(e, a)],
  ['ZREM', (e, a) => zrem.handleZrem(e, a)],
  ['ZCARD', (e, a) => zcard.handleZcard(e, a)],
  ['ZSCORE', (e, a) => zscore.handleZscore(e, a)],
  ['ZRANGE', (e, a) => zrange.handleZrange(e, a)],
  ['ZRANGEBYSCORE', (e, a) => zrangebyscore.handleZrangebyscore(e, a)],
  ['SQLITE.INFO', (e, a) => sqliteInfo.handleSqliteInfo(e, a)],
  ['CACHE.INFO', (e, a) => cacheInfo.handleCacheInfo(e, a)],
  ['MEMORY.INFO', (e, a) => memoryInfo.handleMemoryInfo(e, a)],
  ['FT.CREATE', (e, a) => ftCreate.handleFtCreate(e, a)],
  ['FT.INFO', (e, a) => ftInfo.handleFtInfo(e, a)],
  ['FT.ADD', (e, a) => ftAdd.handleFtAdd(e, a)],
  ['FT.DEL', (e, a) => ftDel.handleFtDel(e, a)],
  ['FT.SEARCH', (e, a) => ftSearch.handleFtSearch(e, a)],
  ['FT.SUGADD', (e, a) => ftSugadd.handleFtSugadd(e, a)],
  ['FT.SUGGET', (e, a) => ftSugget.handleFtSugget(e, a)],
  ['FT.SUGDEL', (e, a) => ftSugdel.handleFtSugdel(e, a)],
]);

/**
 * Dispatch command. Full argv: [commandNameBuf, ...argBuffers].
 * @param {object} engine
 * @param {Buffer[]} argv - first element is command name, rest are arguments
 * @param {object} [context] - optional connection context (connectionId, writeResponse) for blocking commands
 * @returns {{ result: unknown } | { error: string } | { quit: true } | { block: object }}
 */
export function dispatch(engine, argv, context) {
  if (!argv || argv.length === 0) {
    return { error: 'ERR wrong number of arguments' };
  }
  const cmd = (Buffer.isBuffer(argv[0]) ? argv[0].toString('utf8') : String(argv[0])).toUpperCase();
  const args = argv.slice(1);
  const handler = HANDLERS.get(cmd);
  if (!handler) {
    return { error: unsupported() };
  }
  try {
    const result = handler(engine, args, context);
    if (result && result.quit) return result;
    if (result && result.error) return result;
    if (result && result.block) return result;
    return { result };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return { error: msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}

export function register(name, handler) {
  HANDLERS.set(String(name).toUpperCase(), handler);
}
