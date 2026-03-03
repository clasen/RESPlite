/**
 * LRU cache with max entries and max bytes limits.
 * Entry: { kind, version, expiresAt, value } per SPEC 12.3.
 */

export function createLRU(opts = {}) {
  const maxEntries = opts.maxEntries ?? 50000;
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  const map = new Map();
  let totalBytes = 0;
  let hits = 0;
  let misses = 0;

  function estimateSize(value) {
    if (value == null) return 0;
    if (Buffer.isBuffer(value)) return value.length;
    if (typeof value === 'string') return value.length * 2;
    if (Array.isArray(value)) return value.reduce((s, v) => s + estimateSize(v), 0);
    if (value instanceof Map) {
      let s = 0;
      for (const [k, v] of value) s += estimateSize(k) + estimateSize(v);
      return s;
    }
    return 8;
  }

  function evictOne() {
    const first = map.keys().next();
    if (first.done) return;
    const key = first.value;
    const ent = map.get(key);
    map.delete(key);
    totalBytes -= estimateSize(ent.value);
  }

  function get(key) {
    const ent = map.get(key);
    if (!ent) {
      misses++;
      return null;
    }
    hits++;
    map.delete(key);
    map.set(key, ent);
    return ent;
  }

  function set(key, entry) {
    const size = estimateSize(entry.value);
    while (map.size >= maxEntries || (totalBytes + size > maxBytes && map.size > 0)) {
      evictOne();
    }
    if (map.has(key)) {
      const old = map.get(key);
      totalBytes -= estimateSize(old.value);
    }
    map.set(key, entry);
    totalBytes += size;
  }

  function del(key) {
    const ent = map.get(key);
    if (ent) {
      map.delete(key);
      totalBytes -= estimateSize(ent.value);
    }
  }

  return {
    get,
    set,
    del,
    get stats() {
      return {
        entries: map.size,
        bytes: totalBytes,
        hits,
        misses,
        hitRatio: hits + misses > 0 ? hits / (hits + misses) : 0,
      };
    },
  };
}
