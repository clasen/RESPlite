/**
 * CACHE.INFO - cache stats (enabled, entries, bytes, hits, misses, ratio).
 */

import type { CommandReply, Engine } from '../types.ts';

/** Cache stats as ordered [name, value] pairs, shared with INFO. */
export function readCacheStats(engine: Engine): [string, string][] {
  const s: Partial<NonNullable<Engine['_cache']>['stats']> = engine._cache?.stats ?? {};
  return [
    ['enabled', s.enabled ? '1' : '0'],
    ['entries', String(s.entries ?? 0)],
    ['bytes', String(s.bytes ?? 0)],
    ['hits', String(s.hits ?? 0)],
    ['misses', String(s.misses ?? 0)],
    ['hit_ratio', (s.hitRatio ?? 0).toFixed(4)],
  ];
}

export function handleCacheInfo(engine: Engine, args: Buffer[]): CommandReply {
  return readCacheStats(engine).flat();
}
