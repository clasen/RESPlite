/**
 * Command registry: normalize to uppercase, route to handler, return unsupported error for unknown.
 */

import { unsupported } from '../engine/errors.ts';
import * as ping from './ping.ts';
import * as echo from './echo.ts';
import * as quit from './quit.ts';
import * as get from './get.ts';
import * as set from './set.ts';
import * as setex from './setex.ts';
import * as setnx from './setnx.ts';
import * as strlen from './strlen.ts';
import * as del from './del.ts';
import * as unlink from './unlink.ts';
import * as exists from './exists.ts';
import * as dbsize from './dbsize.ts';
import * as flushdb from './flushdb.ts';
import * as flushall from './flushall.ts';
import * as type from './type.ts';
import * as object from './object.ts';
import * as mget from './mget.ts';
import * as mset from './mset.ts';
import * as msetnx from './msetnx.ts';
import * as expire from './expire.ts';
import * as pexpire from './pexpire.ts';
import * as ttl from './ttl.ts';
import * as pttl from './pttl.ts';
import * as persist from './persist.ts';
import * as incr from './incr.ts';
import * as decr from './decr.ts';
import * as incrby from './incrby.ts';
import * as decrby from './decrby.ts';
import * as hset from './hset.ts';
import * as hsetnx from './hsetnx.ts';
import * as hmset from './hmset.ts';
import * as hget from './hget.ts';
import * as hmget from './hmget.ts';
import * as hgetall from './hgetall.ts';
import * as hkeys from './hkeys.ts';
import * as hvals from './hvals.ts';
import * as hdel from './hdel.ts';
import * as hlen from './hlen.ts';
import * as hexists from './hexists.ts';
import * as hincrby from './hincrby.ts';
import * as hincrbyfloat from './hincrbyfloat.ts';
import * as hstrlen from './hstrlen.ts';
import * as hscan from './hscan.ts';
import * as hrandfield from './hrandfield.ts';
import * as hexpireCmd from './hexpire.ts';
import * as hpexpireCmd from './hpexpire.ts';
import * as hexpireatCmd from './hexpireat.ts';
import * as hpexpireatCmd from './hpexpireat.ts';
import * as httlCmd from './httl.ts';
import * as hpttlCmd from './hpttl.ts';
import * as hexpiretimeCmd from './hexpiretime.ts';
import * as hpexpiretimeCmd from './hpexpiretime.ts';
import * as hpersistCmd from './hpersist.ts';
import * as sadd from './sadd.ts';
import * as srem from './srem.ts';
import * as smembers from './smembers.ts';
import * as sismember from './sismember.ts';
import * as smismember from './smismember.ts';
import * as scard from './scard.ts';
import * as spop from './spop.ts';
import * as srandmember from './srandmember.ts';
import * as lpush from './lpush.ts';
import * as rpush from './rpush.ts';
import * as llen from './llen.ts';
import * as lrange from './lrange.ts';
import * as lindex from './lindex.ts';
import * as lpop from './lpop.ts';
import * as rpop from './rpop.ts';
import * as lrem from './lrem.ts';
import * as lset from './lset.ts';
import * as ltrim from './ltrim.ts';
import * as blpop from './blpop.ts';
import * as brpop from './brpop.ts';
import * as lmpop from './lmpop.ts';
import * as scan from './scan.ts';
import * as keys from './keys.ts';
import * as rename from './rename.ts';
import * as zadd from './zadd.ts';
import * as zrem from './zrem.ts';
import * as zcard from './zcard.ts';
import * as zscore from './zscore.ts';
import * as zmscore from './zmscore.ts';
import * as zmpop from './zmpop.ts';
import * as zrange from './zrange.ts';
import * as zrangebyscore from './zrangebyscore.ts';
import * as zrevrange from './zrevrange.ts';
import * as zrevrangebyscore from './zrevrangebyscore.ts';
import * as zrevrank from './zrevrank.ts';
import * as zrank from './zrank.ts';
import * as zcount from './zcount.ts';
import * as zincrby from './zincrby.ts';
import * as zremrangebyrank from './zremrangebyrank.ts';
import * as zremrangebyscore from './zremrangebyscore.ts';
import * as sqliteInfo from './sqlite-info.ts';
import * as cacheInfo from './cache-info.ts';
import * as memoryInfo from './memory-info.ts';
import * as info from './info.ts';
import * as memory from './memory.ts';
import * as ftCreate from './ft-create.ts';
import * as ftInfo from './ft-info.ts';
import * as ftAdd from './ft-add.ts';
import * as ftDel from './ft-del.ts';
import * as ftGet from './ft-get.ts';
import * as ftSearch from './ft-search.ts';
import * as ftSugadd from './ft-sugadd.ts';
import * as ftSugget from './ft-sugget.ts';
import * as ftSugdel from './ft-sugdel.ts';
import * as monitor from './monitor.ts';
import * as client from './client.ts';
import * as command from './command.ts';
import * as publish from './publish.ts';
import * as subscribe from './subscribe.ts';
import * as unsubscribe from './unsubscribe.ts';
import * as psubscribe from './psubscribe.ts';
import * as punsubscribe from './punsubscribe.ts';
import * as pubsub from './pubsub.ts';
import { SCRIPTING_COMMANDS } from '../scripting/commands.ts';
import type { BlockRequest, CommandContext, CommandHandler, CommandReply, Engine, RespValue } from '../types.ts';

const COMPILED_POLICY_TAG = Symbol('compiled-command-policy');

export interface CommandPolicy {
  rename?: Record<string, string>;
  disabled?: string[];
}

export interface CompiledCommandPolicy {
  [COMPILED_POLICY_TAG]: true;
  disabledSet: Set<string>;
  aliasToOriginal: Map<string, string>;
  renamedOriginals: Set<string>;
}

const HANDLERS = new Map<string, CommandHandler>([
  ...[...SCRIPTING_COMMANDS].map((name): [string, CommandHandler] => [name, (e, a, ctx) => ctx!.scripting!.execute(name, e, a, ctx!)]),
  ['PING', (e, a, ctx) => ping.handlePing(a, ctx)],
  ['ECHO', (e, a) => echo.handleEcho(a)],
  ['QUIT', (e, a) => quit.handleQuit()],
  ['GET', (e, a) => get.handleGet(e, a)],
  ['SET', (e, a) => set.handleSet(e, a)],
  ['SETEX', (e, a) => setex.handleSetex(e, a)],
  ['SETNX', (e, a) => setnx.handleSetnx(e, a)],
  ['STRLEN', (e, a) => strlen.handleStrlen(e, a)],
  ['DEL', (e, a) => del.handleDel(e, a)],
  ['UNLINK', (e, a) => unlink.handleUnlink(e, a)],
  ['EXISTS', (e, a) => exists.handleExists(e, a)],
  ['DBSIZE', (e, a) => dbsize.handleDbsize(e, a)],
  ['FLUSHDB', (e, a) => flushdb.handleFlushdb(e, a)],
  ['FLUSHALL', (e, a) => flushall.handleFlushall(e, a)],
  ['TYPE', (e, a) => type.handleType(e, a)],
  ['OBJECT', (e, a) => object.handleObject(e, a)],
  ['MGET', (e, a) => mget.handleMget(e, a)],
  ['MSET', (e, a) => mset.handleMset(e, a)],
  ['MSETNX', (e, a) => msetnx.handleMsetnx(e, a)],
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
  ['HSETNX', (e, a) => hsetnx.handleHsetnx(e, a)],
  ['HMSET', (e, a) => hmset.handleHmset(e, a)],
  ['HGET', (e, a) => hget.handleHget(e, a)],
  ['HMGET', (e, a) => hmget.handleHmget(e, a)],
  ['HGETALL', (e, a) => hgetall.handleHgetall(e, a)],
  ['HKEYS', (e, a) => hkeys.handleHkeys(e, a)],
  ['HVALS', (e, a) => hvals.handleHvals(e, a)],
  ['HDEL', (e, a) => hdel.handleHdel(e, a)],
  ['HLEN', (e, a) => hlen.handleHlen(e, a)],
  ['HEXISTS', (e, a) => hexists.handleHexists(e, a)],
  ['HINCRBY', (e, a) => hincrby.handleHincrby(e, a)],
  ['HINCRBYFLOAT', (e, a) => hincrbyfloat.handleHincrbyfloat(e, a)],
  ['HSTRLEN', (e, a) => hstrlen.handleHstrlen(e, a)],
  ['HSCAN', (e, a) => hscan.handleHscan(e, a)],
  ['HRANDFIELD', (e, a) => hrandfield.handleHrandfield(e, a)],
  ['HEXPIRE', (e, a) => hexpireCmd.handleHexpire(e, a)],
  ['HPEXPIRE', (e, a) => hpexpireCmd.handleHpexpire(e, a)],
  ['HEXPIREAT', (e, a) => hexpireatCmd.handleHexpireat(e, a)],
  ['HPEXPIREAT', (e, a) => hpexpireatCmd.handleHpexpireat(e, a)],
  ['HTTL', (e, a) => httlCmd.handleHttl(e, a)],
  ['HPTTL', (e, a) => hpttlCmd.handleHpttl(e, a)],
  ['HEXPIRETIME', (e, a) => hexpiretimeCmd.handleHexpiretime(e, a)],
  ['HPEXPIRETIME', (e, a) => hpexpiretimeCmd.handleHpexpiretime(e, a)],
  ['HPERSIST', (e, a) => hpersistCmd.handleHpersist(e, a)],
  ['SADD', (e, a) => sadd.handleSadd(e, a)],
  ['SREM', (e, a) => srem.handleSrem(e, a)],
  ['SMEMBERS', (e, a) => smembers.handleSmembers(e, a)],
  ['SISMEMBER', (e, a) => sismember.handleSismember(e, a)],
  ['SMISMEMBER', (e, a) => smismember.handleSmismember(e, a)],
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
  ['LMPOP', (e, a) => lmpop.handleLmpop(e, a)],
  ['SCAN', (e, a) => scan.handleScan(e, a)],
  ['KEYS', (e, a) => keys.handleKeys(e, a)],
  ['RENAME', (e, a) => rename.handleRename(e, a)],
  ['ZADD', (e, a) => zadd.handleZadd(e, a)],
  ['ZREM', (e, a) => zrem.handleZrem(e, a)],
  ['ZCARD', (e, a) => zcard.handleZcard(e, a)],
  ['ZSCORE', (e, a) => zscore.handleZscore(e, a)],
  ['ZMSCORE', (e, a) => zmscore.handleZmscore(e, a)],
  ['ZMPOP', (e, a) => zmpop.handleZmpop(e, a)],
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
  ['INFO', (e, a, ctx) => info.handleInfo(e, a, ctx)],
  ['MEMORY', (e, a, ctx) => memory.handleMemory(e, a, ctx)],
  ['FT.CREATE', (e, a) => ftCreate.handleFtCreate(e, a)],
  ['FT.INFO', (e, a) => ftInfo.handleFtInfo(e, a)],
  ['FT.ADD', (e, a) => ftAdd.handleFtAdd(e, a)],
  ['FT.DEL', (e, a) => ftDel.handleFtDel(e, a)],
  ['FT.GET', (e, a) => ftGet.handleFtGet(e, a)],
  ['FT.SEARCH', (e, a) => ftSearch.handleFtSearch(e, a)],
  ['FT.SUGADD', (e, a) => ftSugadd.handleFtSugadd(e, a)],
  ['FT.SUGGET', (e, a) => ftSugget.handleFtSugget(e, a)],
  ['FT.SUGDEL', (e, a) => ftSugdel.handleFtSugdel(e, a)],
  ['MONITOR', (e, a) => monitor.handleMonitor(a)],
  ['CLIENT', (e, a, ctx) => client.handleClient(e, a, ctx)],
  ['COMMAND', (e, a, ctx) => command.handleCommand(e, a, ctx)],
  ['PUBLISH', (e, a, ctx) => publish.handlePublish(a, ctx)],
  ['SUBSCRIBE', (e, a, ctx) => subscribe.handleSubscribe(a, ctx)],
  ['UNSUBSCRIBE', (e, a, ctx) => unsubscribe.handleUnsubscribe(a, ctx)],
  ['PSUBSCRIBE', (e, a, ctx) => psubscribe.handlePsubscribe(a, ctx)],
  ['PUNSUBSCRIBE', (e, a, ctx) => punsubscribe.handlePunsubscribe(a, ctx)],
  ['PUBSUB', (e, a, ctx) => pubsub.handlePubsub(a, ctx)],
]);

function assertCommandName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid command policy: ${field} must be a non-empty string`);
  }
  return value.trim().toUpperCase();
}

function isCompiledPolicy(value: unknown): value is CompiledCommandPolicy {
  return !!(value && typeof value === 'object' && (value as CompiledCommandPolicy)[COMPILED_POLICY_TAG] === true);
}

export function compileCommandPolicy(
  policy: CommandPolicy | CompiledCommandPolicy | null | undefined = {}
): CompiledCommandPolicy | null {
  if (policy == null) return null;
  if (isCompiledPolicy(policy)) return policy;
  if (typeof policy !== 'object') {
    throw new Error('invalid command policy: expected an object');
  }

  const rename = policy.rename ?? {};
  const disabled = policy.disabled ?? [];

  if (rename == null || typeof rename !== 'object' || Array.isArray(rename)) {
    throw new Error('invalid command policy: rename must be an object');
  }
  if (!Array.isArray(disabled)) {
    throw new Error('invalid command policy: disabled must be an array');
  }

  const knownCommands = new Set(HANDLERS.keys());
  const renamedOriginals = new Set<string>();
  const aliasToOriginal = new Map<string, string>();

  for (const [rawOriginal, rawAlias] of Object.entries(rename)) {
    const original = assertCommandName(rawOriginal, 'rename key');
    const alias = assertCommandName(rawAlias, `rename.${rawOriginal}`);
    if (!knownCommands.has(original)) {
      throw new Error(`invalid command policy: cannot rename unknown command "${original}"`);
    }
    if (alias === original) {
      throw new Error(`invalid command policy: alias for "${original}" must be different`);
    }
    if (knownCommands.has(alias)) {
      throw new Error(`invalid command policy: alias "${alias}" conflicts with existing command`);
    }
    if (aliasToOriginal.has(alias)) {
      throw new Error(`invalid command policy: alias "${alias}" is duplicated`);
    }
    renamedOriginals.add(original);
    aliasToOriginal.set(alias, original);
  }

  const disabledSet = new Set<string>();
  for (const rawName of disabled) {
    const name = assertCommandName(rawName, 'disabled[] item');
    disabledSet.add(name);
  }

  return {
    [COMPILED_POLICY_TAG]: true,
    disabledSet,
    aliasToOriginal,
    renamedOriginals,
  };
}

function listVisibleCommandNames(policy: CompiledCommandPolicy | null, scripting: unknown): string[] {
  const names: string[] = [];
  for (const name of HANDLERS.keys()) {
    if (SCRIPTING_COMMANDS.has(name) && !scripting) continue;
    if (policy?.renamedOriginals?.has(name)) continue;
    if (policy?.disabledSet?.has(name)) continue;
    names.push(name);
  }
  return names;
}

function resolveIncomingCommand(
  inputCommand: string,
  policy: CompiledCommandPolicy | null
): { blocked: boolean; resolvedCommand: string } {
  if (!policy) return { blocked: false, resolvedCommand: inputCommand };
  if (policy.disabledSet.has(inputCommand)) {
    return { blocked: true, resolvedCommand: inputCommand };
  }
  const target = policy.aliasToOriginal.get(inputCommand);
  if (target) return { blocked: false, resolvedCommand: target };
  if (policy.renamedOriginals.has(inputCommand)) {
    return { blocked: true, resolvedCommand: inputCommand };
  }
  return { blocked: false, resolvedCommand: inputCommand };
}

export function resolveCommandName(
  inputCommand: string,
  policy: CommandPolicy | CompiledCommandPolicy | null = null
): string | null {
  const normalized = String(inputCommand).toUpperCase();
  const resolution = resolveIncomingCommand(normalized, compileCommandPolicy(policy));
  return resolution.blocked ? null : resolution.resolvedCommand;
}

function stringifyArgv(argv: Buffer[]): string[] {
  return argv.map((b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b)));
}

/** Outcome of one command: a reply to encode, an error, or a control instruction. */
export interface DispatchResult {
  result?: CommandReply;
  error?: string;
  quit?: true;
  block?: BlockRequest;
  pushes?: RespValue[];
}

/**
 * Dispatch command. Full argv: [commandNameBuf, ...argBuffers].
 * @param argv - first element is command name, rest are arguments
 * @param context - optional connection context (connectionId, clientAddress, writeResponse, onUnknownCommand, onCommandError)
 */
export function dispatch(engine: Engine, argv: Buffer[], context?: CommandContext): DispatchResult {
  if (!argv || argv.length === 0) {
    return { error: 'ERR wrong number of arguments' };
  }
  const cmd = (Buffer.isBuffer(argv[0]) ? argv[0].toString('utf8') : String(argv[0])).toUpperCase();
  const args = argv.slice(1);
  const policy = compileCommandPolicy(context?.commandPolicy);
  const commandResolution = resolveIncomingCommand(cmd, policy);
  if (commandResolution.blocked) {
    context?.onUnknownCommand?.({
      command: cmd,
      argsCount: args.length,
      argv: stringifyArgv(argv),
      clientAddress: context?.clientAddress ?? '',
      connectionId: context?.connectionId ?? 0,
    });
    return { error: unsupported() };
  }
  const resolvedCommand = commandResolution.resolvedCommand;
  if (context) {
    context.getCommandNames = () => listVisibleCommandNames(policy, context.scripting);
    context.resolveCommandForIntrospection = (name: string) => {
      if (!policy) return name;
      return policy.aliasToOriginal.get(String(name).toUpperCase()) ?? String(name).toUpperCase();
    };
  }
  const handler = HANDLERS.get(resolvedCommand);
  if (!handler || (SCRIPTING_COMMANDS.has(resolvedCommand) && !context?.scripting)) {
    context?.onUnknownCommand?.({
      command: cmd,
      argsCount: args.length,
      argv: stringifyArgv(argv),
      clientAddress: context?.clientAddress ?? '',
      connectionId: context?.connectionId ?? 0,
    });
    return { error: unsupported() };
  }
  try {
    const result = handler(engine, args, context);
    // Replies are plain values; control instructions and errors are marked objects.
    const marked = result as DispatchResult | null | undefined;
    if (marked && marked.quit) return marked;
    if (marked && marked.pushes) return marked;
    if (marked && marked.error) {
      context?.onCommandError?.({
        command: cmd,
        error: marked.error,
        argv: stringifyArgv(argv),
        clientAddress: context?.clientAddress ?? '',
        connectionId: context?.connectionId ?? 0,
      });
      return marked;
    }
    if (marked && marked.block) return marked;
    return { result };
  } catch (err) {
    const msg = err instanceof Error && err.message ? err.message : String(err);
    // Redis sends the error code as the first token; only prefix messages without one.
    const errorMsg = msg.startsWith('ERR ') || msg.startsWith('WRONGTYPE ') ? msg : 'ERR ' + msg;
    context?.onCommandError?.({
      command: cmd,
      error: errorMsg,
      argv: stringifyArgv(argv),
      clientAddress: context?.clientAddress ?? '',
      connectionId: context?.connectionId ?? 0,
    });
    return { error: errorMsg };
  }
}

export function register(name: string, handler: CommandHandler): void {
  HANDLERS.set(String(name).toUpperCase(), handler);
}
