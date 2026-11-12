/**
 * MEMORY USAGE | STATS | PURGE | HELP.
 * Process memory comes from the Node.js runtime; key usage is the stored size
 * of the key name and its payload in SQLite, not Redis allocator overhead.
 */

import { parseInteger } from '../util/integers.ts';
import type { CommandContext, CommandReply, Engine } from '../types.ts';

const HELP_LINES = [
  'MEMORY <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
  'STATS',
  '    Return information about the memory usage of the server.',
  'USAGE <key> [SAMPLES <count>]',
  '    Return the stored size in bytes of the key name and its value.',
  '    SAMPLES is accepted for compatibility; the size is always exact.',
  'PURGE',
  '    No-op; memory is managed by the Node.js runtime.',
  'HELP',
  '    Print this help.',
];

/** Node.js process memory figures in bytes, shared with INFO. */
export function readProcessMemory() {
  const mu = process.memoryUsage();
  return {
    used: mu.heapUsed + mu.external,
    rss: mu.rss,
    peak: Math.max(process.resourceUsage().maxRSS * 1024, mu.rss),
    heapUsed: mu.heapUsed,
    heapTotal: mu.heapTotal,
    external: mu.external,
  };
}

function wrongArgs(sub: string): { error: string } {
  return { error: `ERR wrong number of arguments for 'memory|${sub.toLowerCase()}' command` };
}

function handleUsage(engine: Engine, args: Buffer[]): CommandReply {
  if (args.length !== 2 && args.length !== 4) return wrongArgs('USAGE');
  if (args.length === 4) {
    if (args[2].toString('utf8').toUpperCase() !== 'SAMPLES') return { error: 'ERR syntax error' };
    parseInteger(args[3]);
  }
  return engine.memoryUsage(args[1]);
}

function handleStats(engine: Engine, args: Buffer[], context: CommandContext): CommandReply {
  if (args.length !== 1) return wrongArgs('STATS');
  const mem = readProcessMemory();
  return [
    'peak.allocated', mem.peak,
    'total.allocated', mem.used,
    'startup.allocated', context.serverStats!.startupRss,
    'rss', mem.rss,
    'heap.used', mem.heapUsed,
    'heap.total', mem.heapTotal,
    'external', mem.external,
    'cache.bytes', engine._cache?.stats.bytes ?? 0,
    'keys.count', engine.dbsize(),
    'sqlite.bytes', engine.databaseBytes(),
  ];
}

export function handleMemory(engine: Engine, args: Buffer[], context?: CommandContext): CommandReply {
  if (args.length === 0) return { error: "ERR wrong number of arguments for 'memory' command" };
  const sub = args[0].toString('utf8').toUpperCase();
  switch (sub) {
    case 'USAGE':
      return handleUsage(engine, args);
    case 'STATS':
      if (!context?.serverStats) throw new Error('MEMORY STATS requires a connection context with serverStats');
      return handleStats(engine, args, context);
    case 'PURGE':
      return args.length === 1 ? { simple: 'OK' } : wrongArgs('PURGE');
    case 'HELP':
      return args.length === 1 ? HELP_LINES.map((line) => ({ simple: line })) : wrongArgs('HELP');
    default:
      return { error: `ERR unknown subcommand '${args[0].toString('utf8')}'. Try MEMORY HELP.` };
  }
}
