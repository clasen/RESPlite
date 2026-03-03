/**
 * Cache layer: optional LRU in front of storage. Invalidates on write.
 */

import { createLRU } from './lru.js';

export function createCache(opts = {}) {
  const enabled = opts.enabled !== false;
  const lru = createLRU({
    maxEntries: opts.maxEntries ?? 50000,
    maxBytes: opts.maxBytes ?? 64 * 1024 * 1024,
  });

  return {
    get(key) {
      if (!enabled) return null;
      const ent = lru.get(key);
      if (!ent) return null;
      return ent;
    },
    set(key, kind, value, version, expiresAt) {
      if (!enabled) return;
      lru.set(key, { kind, version, expiresAt, value });
    },
    invalidate(key) {
      if (!enabled) return;
      lru.del(key);
    },
    get stats() {
      return { enabled, ...lru.stats };
    },
  };
}
