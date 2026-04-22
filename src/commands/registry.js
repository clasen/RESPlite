/**
 * Command registry: normalize to uppercase, route to handler, return unsupported error for unknown.
 */

import { unsupported } from '../engine/errors.js';
import * as ping from './ping.js';
import * as echo from './echo.js';
import * as quit from './quit.js';
import * as get from './get.js';
import * as set from './set.js';
import * as setex from './setex.js';
import * as strlen from './strlen.js';
import * as del from './del.js';
import * as unlink from './unlink.js';
import * as exists from './exists.js';
import * as type from './type.js';
import * as object from './object.js';
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
import * as hkeys from './hkeys.js';
import * as hvals from './hvals.js';
import * as hdel from './hdel.js';
import * as hlen from './hlen.js';
import * as hexists from './hexists.js';
import * as hincrby from './hincrby.js';
import * as hexpireCmd from './hexpire.js';
import * as httlCmd from './httl.js';
import * as hpersistCmd from './hpersist.js';
import * as sadd from './sadd.js';
import * as srem from './srem.js';
import * as smembers from './smembers.js';
import * as sismember from './sismember.js';
import * as scard from './scard.js';
import * as spop from './spop.js';
import * as srandmember from './srandmember.js';
import * as lpush from './lpush.js';
import * as rpush from './rpush.js';
import * as llen from './llen.js';
import * as lrange from './lrange.js';
import * as lindex from './lindex.js';
import * as lpop from './lpop.js';
import * as rpop from './rpop.js';
import * as lrem from './lrem.js';
import * as lset from './lset.js';
import * as ltrim from './ltrim.js';
import * as blpop from './blpop.js';
import * as brpop from './brpop.js';
import * as scan from './scan.js';
import * as keys from './keys.js';
import * as rename from './rename.js';
import * as zadd from './zadd.js';
import * as zrem from './zrem.js';
import * as zcard from './zcard.js';
import * as zscore from './zscore.js';
import * as zrange from './zrange.js';
import * as zrangebyscore from './zrangebyscore.js';
import * as zrevrange from './zrevrange.js';
import * as zrevrangebyscore from './zrevrangebyscore.js';
import * as zrevrank from './zrevrank.js';
import * as zrank from './zrank.js';
import * as zcount from './zcount.js';
import * as zincrby from './zincrby.js';
import * as zremrangebyrank from './zremrangebyrank.js';
import * as zremrangebyscore from './zremrangebyscore.js';
import * as sqliteInfo from './sqlite-info.js';
import * as cacheInfo from './cache-info.js';
import * as memoryInfo from './memory-info.js';
import * as ftCreate from './ft-create.js';
import * as ftInfo from './ft-info.js';
import * as ftAdd from './ft-add.js';
import * as ftDel from './ft-del.js';
import * as ftGet from './ft-get.js';
import * as ftSearch from './ft-search.js';
import * as ftSugadd from './ft-sugadd.js';
import * as ftSugget from './ft-sugget.js';
import * as ftSugdel from './ft-sugdel.js';
import * as monitor from './monitor.js';
import * as client from './client.js';
import * as command from './command.js';

const HANDLERS = new Map([
  ['PING', (e, a) => ping.handlePing()],
  ['ECHO', (e, a) => echo.handleEcho(a)],
  ['QUIT', (e, a) => quit.handleQuit()],
  ['GET', (e, a) => get.handleGet(e, a)],
  ['SET', (e, a) => set.handleSet(e, a)],
  ['SETEX', (e, a) => setex.handleSetex(e, a)],
  ['STRLEN', (e, a) => strlen.handleStrlen(e, a)],
  ['DEL', (e, a) => del.handleDel(e, a)],
  ['UNLINK', (e, a) => unlink.handleUnlink(e, a)],
  ['EXISTS', (e, a) => exists.handleExists(e, a)],
  ['TYPE', (e, a) => type.handleType(e, a)],
  ['OBJECT', (e, a) => object.handleObject(e, a)],
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
  ['HKEYS', (e, a) => hkeys.handleHkeys(e, a)],
  ['HVALS', (e, a) => hvals.handleHvals(e, a)],
  ['HDEL', (e, a) => hdel.handleHdel(e, a)],
  ['HLEN', (e, a) => hlen.handleHlen(e, a)],
  ['HEXISTS', (e, a) => hexists.handleHexists(e, a)],
  ['HINCRBY', (e, a) => hincrby.handleHincrby(e, a)],
  ['HEXPIRE', (e, a) => hexpireCmd.handleHexpire(e, a)],
  ['HTTL', (e, a) => httlCmd.handleHttl(e, a)],
  ['HPERSIST', (e, a) => hpersistCmd.handleHpersist(e, a)],
  ['SADD', (e, a) => sadd.handleSadd(e, a)],
  ['SREM', (e, a) => srem.handleSrem(e, a)],
  ['SMEMBERS', (e, a) => smembers.handleSmembers(e, a)],
  ['SISMEMBER', (e, a) => sismember.handleSismember(e, a)],
  ['SCARD', (e, a) => scard.handleScard(e, a)],
  ['SPOP', (e, a) => spop.handleSpop(e, a)],
  ['SRANDMEMBER', (e, a) => srandmember.handleSrandmember(e, a)],
  ['LPUSH', (e, a) => lpush.handleLpush(e, a)],
  ['RPUSH', (e, a) => rpush.handleRpush(e, a)],
  ['LLEN', (e, a) => llen.handleLlen(e, a)],
  ['LRANGE', (e, a) => lrange.handleLrange(e, a)],
  ['LINDEX', (e, a) => lindex.handleLindex(e, a)],
  ['LPOP', (e, a, ctx) => lpop.handleLpop(e, a)],
  ['RPOP', (e, a, ctx) => rpop.handleRpop(e, a)],
  ['LREM', (e, a) => lrem.handleLrem(e, a)],
  ['LSET', (e, a) => lset.handleLset(e, a)],
  ['LTRIM', (e, a) => ltrim.handleLtrim(e, a)],
  ['BLPOP', (e, a, ctx) => blpop.handleBlpop(e, a, ctx)],
  ['BRPOP', (e, a, ctx) => brpop.handleBrpop(e, a, ctx)],
  ['SCAN', (e, a) => scan.handleScan(e, a)],
  ['KEYS', (e, a) => keys.handleKeys(e, a)],
  ['RENAME', (e, a) => rename.handleRename(e, a)],
  ['ZADD', (e, a) => zadd.handleZadd(e, a)],
  ['ZREM', (e, a) => zrem.handleZrem(e, a)],
  ['ZCARD', (e, a) => zcard.handleZcard(e, a)],
  ['ZSCORE', (e, a) => zscore.handleZscore(e, a)],
  ['ZRANGE', (e, a) => zrange.handleZrange(e, a)],
  ['ZRANGEBYSCORE', (e, a) => zrangebyscore.handleZrangebyscore(e, a)],
  ['ZREVRANGE', (e, a) => zrevrange.handleZrevrange(e, a)],
  ['ZREVRANGEBYSCORE', (e, a) => zrevrangebyscore.handleZrevrangebyscore(e, a)],
  ['ZREVRANK', (e, a) => zrevrank.handleZrevrank(e, a)],
  ['ZRANK', (e, a) => zrank.handleZrank(e, a)],
  ['ZCOUNT', (e, a) => zcount.handleZcount(e, a)],
  ['ZINCRBY', (e, a) => zincrby.handleZincrby(e, a)],
  ['ZREMRANGEBYRANK', (e, a) => zremrangebyrank.handleZremrangebyrank(e, a)],
  ['ZREMRANGEBYSCORE', (e, a) => zremrangebyscore.handleZremrangebyscore(e, a)],
  ['SQLITE.INFO', (e, a) => sqliteInfo.handleSqliteInfo(e, a)],
  ['CACHE.INFO', (e, a) => cacheInfo.handleCacheInfo(e, a)],
  ['MEMORY.INFO', (e, a) => memoryInfo.handleMemoryInfo(e, a)],
  ['FT.CREATE', (e, a) => ftCreate.handleFtCreate(e, a)],
  ['FT.INFO', (e, a) => ftInfo.handleFtInfo(e, a)],
  ['FT.ADD', (e, a) => ftAdd.handleFtAdd(e, a)],
  ['FT.DEL', (e, a) => ftDel.handleFtDel(e, a)],
  ['FT.GET', (e, a) => ftGet.handleFtGet(e, a)],
  ['FT.SEARCH', (e, a) => ftSearch.handleFtSearch(e, a)],
  ['FT.SUGADD', (e, a) => ftSugadd.handleFtSugadd(e, a)],
  ['FT.SUGGET', (e, a) => ftSugget.handleFtSugget(e, a)],
  ['FT.SUGDEL', (e, a) => ftSugdel.handleFtSugdel(e, a)],
  ['MONITOR', (e, a, ctx) => monitor.handleMonitor(a, ctx)],
  ['CLIENT', (e, a, ctx) => client.handleClient(e, a, ctx)],
  ['COMMAND', (e, a, ctx) => command.handleCommand(e, a, ctx)],
]);

/**
 * Dispatch command. Full argv: [commandNameBuf, ...argBuffers].
 * @param {object} engine
 * @param {Buffer[]} argv - first element is command name, rest are arguments
 * @param {object} [context] - optional connection context (connectionId, clientAddress, writeResponse, onUnknownCommand, onCommandError)
 * @returns {{ result: unknown } | { error: string } | { quit: true } | { block: object }}
 */
export function dispatch(engine, argv, context) {
  if (!argv || argv.length === 0) {
    return { error: 'ERR wrong number of arguments' };
  }
  const cmd = (Buffer.isBuffer(argv[0]) ? argv[0].toString('utf8') : String(argv[0])).toUpperCase();
  const args = argv.slice(1);
  const argvStrings = argv.map((b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b)));
  if (context) context.getCommandNames = () => Array.from(HANDLERS.keys());
  const handler = HANDLERS.get(cmd);
  if (!handler) {
    context?.onUnknownCommand?.({
      command: cmd,
      argsCount: args.length,
      argv: argvStrings ?? [cmd],
      clientAddress: context.clientAddress ?? '',
      connectionId: context.connectionId ?? 0,
    });
    return { error: unsupported() };
  }
  try {
    const result = handler(engine, args, context);
    if (result && result.quit) return result;
    if (result && result.error) {
      context?.onCommandError?.({
        command: cmd,
        error: result.error,
        argv: argvStrings ?? [cmd],
        clientAddress: context.clientAddress ?? '',
        connectionId: context.connectionId ?? 0,
      });
      return result;
    }
    if (result && result.block) return result;
    return { result };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const errorMsg = msg.startsWith('ERR ') ? msg : 'ERR ' + msg;
    context?.onCommandError?.({
      command: cmd,
      error: errorMsg,
      argv: argvStrings ?? [cmd],
      clientAddress: context.clientAddress ?? '',
      connectionId: context.connectionId ?? 0,
    });
    return { error: errorMsg };
  }
}

export function register(name, handler) {
  HANDLERS.set(String(name).toUpperCase(), handler);
}
