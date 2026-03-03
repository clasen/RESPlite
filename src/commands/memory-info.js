/**
 * MEMORY.INFO - process memory usage (heapUsed, heapTotal, rss, external).
 * For benchmarking and introspection of the RESPlite server process.
 */

export function handleMemoryInfo(engine, args) {
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
