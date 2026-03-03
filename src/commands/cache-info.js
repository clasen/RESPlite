/**
 * CACHE.INFO - cache stats (enabled, entries, bytes, hits, misses, ratio).
 */

export function handleCacheInfo(engine, args) {
  const cache = engine._cache;
  if (!cache) {
    return [
      'enabled',
      '0',
      'entries',
      '0',
      'bytes',
      '0',
      'hits',
      '0',
      'misses',
      '0',
      'hit_ratio',
      '0',
    ];
  }
  const s = cache.stats;
  return [
    'enabled',
    s.enabled ? '1' : '0',
    'entries',
    String(s.entries ?? 0),
    'bytes',
    String(s.bytes ?? 0),
    'hits',
    String(s.hits ?? 0),
    'misses',
    String(s.misses ?? 0),
    'hit_ratio',
    String((s.hitRatio ?? 0).toFixed(4)),
  ];
}
