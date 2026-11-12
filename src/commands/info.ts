/**
 * INFO [section ...] - Redis-style server report as a bulk string.
 * Standard sections: server, clients, memory, persistence, stats, keyspace.
 * RESPlite sections: sqlite, cache.
 */

import fs from 'node:fs';
import os from 'node:os';
import { readCacheStats } from './cache-info.ts';
import { readSqliteInfo } from './sqlite-info.ts';
import { readProcessMemory } from './memory.ts';
import type { CommandContext, CommandReply, Engine } from '../types.ts';
import type { ServerStats } from '../server/stats.ts';

type InfoContext = CommandContext & { serverStats: ServerStats };
type InfoField = [string, string | number];

const RESPLITE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version;

/** Redis release whose command semantics RESPlite follows. */
const REDIS_COMPAT_VERSION = '7.4.0';

const ALL_SECTION_ALIASES = new Set(['default', 'all', 'everything']);

function humanBytes(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value}B` : `${value.toFixed(2)}${units[unit]}`;
}

function serverSection(engine: Engine, context: InfoContext): InfoField[] {
  const { serverStats } = context;
  const now = serverStats.clock();
  const uptimeSeconds = Math.floor((now - serverStats.startedAt) / 1000);
  return [
    ['redis_version', REDIS_COMPAT_VERSION],
    ['resplite_version', RESPLITE_VERSION],
    ['redis_mode', 'standalone'],
    ['os', `${os.type()} ${os.release()} ${os.arch()}`],
    ['arch_bits', process.arch.includes('64') ? 64 : 32],
    ['node_version', process.versions.node],
    ['process_id', process.pid],
    ['tcp_port', context.localPort],
    ['server_time_usec', now * 1000],
    ['uptime_in_seconds', uptimeSeconds],
    ['uptime_in_days', Math.floor(uptimeSeconds / 86400)],
  ];
}

function clientsSection(engine: Engine, context: InfoContext): InfoField[] {
  return [
    ['connected_clients', context.serverStats.connectedClients],
    ['blocked_clients', engine._blockingManager!.blockedClientCount()],
    ['pubsub_clients', context.pubSub?.clientCount() ?? 0],
  ];
}

function memorySection(engine: Engine, context: InfoContext): InfoField[] {
  const mem = readProcessMemory();
  return [
    ['used_memory', mem.used],
    ['used_memory_human', humanBytes(mem.used)],
    ['used_memory_rss', mem.rss],
    ['used_memory_rss_human', humanBytes(mem.rss)],
    ['used_memory_peak', mem.peak],
    ['used_memory_peak_human', humanBytes(mem.peak)],
    ['used_memory_startup', context.serverStats.startupRss],
    ['used_memory_heap', mem.heapUsed],
    ['used_memory_heap_total', mem.heapTotal],
    ['used_memory_external', mem.external],
    ['maxmemory', 0],
    ['maxmemory_human', '0B'],
    ['maxmemory_policy', 'noeviction'],
  ];
}

function persistenceSection(): InfoField[] {
  return [
    ['loading', 0],
    ['async_loading', 0],
    ['rdb_bgsave_in_progress', 0],
    ['aof_enabled', 0],
    ['aof_rewrite_in_progress', 0],
  ];
}

function statsSection(engine: Engine, context: InfoContext): InfoField[] {
  const { serverStats, pubSub } = context;
  return [
    ['total_connections_received', serverStats.totalConnectionsReceived],
    ['total_commands_processed', serverStats.totalCommandsProcessed],
    ['pubsub_channels', pubSub?.channelCount() ?? 0],
    ['pubsub_patterns', pubSub?.numpat() ?? 0],
  ];
}

function sqliteSection(engine: Engine): InfoField[] {
  return [
    ...readSqliteInfo(engine).map(([name, value]): InfoField => [`sqlite_${name}`, value]),
    ['sqlite_db_bytes', engine.databaseBytes()],
  ];
}

function cacheSection(engine: Engine): InfoField[] {
  return readCacheStats(engine).map(([name, value]): InfoField => [`cache_${name}`, value]);
}

function keyspaceSection(engine: Engine): InfoField[] {
  const { keys, expires, avgTtlMs } = engine.keyspaceInfo();
  if (keys === 0) return [];
  return [['db0', `keys=${keys},expires=${expires},avg_ttl=${avgTtlMs}`]];
}

const SECTIONS: [string, string, (engine: Engine, context: InfoContext) => InfoField[]][] = [
  ['server', 'Server', serverSection],
  ['clients', 'Clients', clientsSection],
  ['memory', 'Memory', memorySection],
  ['persistence', 'Persistence', persistenceSection],
  ['stats', 'Stats', statsSection],
  ['sqlite', 'SQLite', sqliteSection],
  ['cache', 'Cache', cacheSection],
  ['keyspace', 'Keyspace', keyspaceSection],
];

export function handleInfo(engine: Engine, args: Buffer[], context?: CommandContext): CommandReply {
  if (!context?.serverStats) throw new Error('INFO requires a connection context with serverStats');
  const requested = args.map((arg) => arg.toString('utf8').toLowerCase());
  const includeAll = requested.length === 0 || requested.some((name) => ALL_SECTION_ALIASES.has(name));
  const selected = new Set(requested);
  const blocks: string[] = [];
  for (const [name, title, build] of SECTIONS) {
    if (!includeAll && !selected.has(name)) continue;
    const lines = build(engine, context as InfoContext).map(([field, value]) => `${field}:${value}\r\n`);
    blocks.push(`# ${title}\r\n${lines.join('')}`);
  }
  return blocks.join('\r\n');
}
