/**
 * MEMORY.INFO - process memory usage (heapUsed, heapTotal, rss, external).
 * For benchmarking and introspection of the RESPlite server process.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleMemoryInfo(engine: Engine, args: Buffer[]): CommandReply {
  const mu = process.memoryUsage();
  return [
    'heapUsed',
    String(mu.heapUsed),
    'heapTotal',
    String(mu.heapTotal),
    'rss',
    String(mu.rss),
    'external',
    String(mu.external ?? 0),
  ];
}
