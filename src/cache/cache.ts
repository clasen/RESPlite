/**
 * Cache layer: optional LRU in front of storage. Invalidates on write.
 */

import { createLRU } from './lru.ts';

/** Cached value per data type; collection maps are keyed by the latin1 form of the field or member. */
export interface CacheValues {
  string: Buffer;
  hash: Map<string, [Buffer, Buffer]>;
  set: Map<string, Buffer>;
  list: Buffer[];
  zset: Map<string, [Buffer, string, number]>;
}

export type CacheKind = keyof CacheValues;

export type CacheEntry = {
  [K in CacheKind]: {
    kind: K;
    version: number;
    expiresAt: number | bigint | null;
    value: CacheValues[K];
  };
}[CacheKind];

export interface CacheOptions {
  enabled?: boolean;
  maxEntries?: number;
  maxBytes?: number;
  maxHashFields?: number;
  maxHashBytes?: number;
  maxSetMembers?: number;
  maxSetBytes?: number;
  maxListItems?: number;
  maxListBytes?: number;
  maxZsetMembers?: number;
  maxZsetBytes?: number;
}

export function createCache(opts: CacheOptions = {}) {
  const enabled = opts.enabled !== false;
  const limits = Object.freeze({
    maxHashFields: opts.maxHashFields ?? 256,
    maxHashBytes: opts.maxHashBytes ?? 256 * 1024,
    maxSetMembers: opts.maxSetMembers ?? 256,
    maxSetBytes: opts.maxSetBytes ?? 256 * 1024,
    maxListItems: opts.maxListItems ?? 256,
    maxListBytes: opts.maxListBytes ?? 256 * 1024,
    maxZsetMembers: opts.maxZsetMembers ?? 256,
    maxZsetBytes: opts.maxZsetBytes ?? 256 * 1024,
  });
  const lru = createLRU<CacheEntry>({
    maxEntries: opts.maxEntries ?? 50000,
    maxBytes: opts.maxBytes ?? 64 * 1024 * 1024,
  });

  return {
    get(key: string): CacheEntry | null {
      if (!enabled) return null;
      const ent = lru.get(key);
      if (!ent) return null;
      return ent;
    },
    set<K extends CacheKind>(
      key: string,
      kind: K,
      value: CacheValues[K],
      version: number,
      expiresAt: number | bigint | null,
    ): void {
      if (!enabled) return;
      lru.set(key, { kind, version, expiresAt, value } as CacheEntry);
    },
    invalidate(key: string): void {
      if (!enabled) return;
      lru.del(key);
    },
    clear(): void {
      if (!enabled) return;
      lru.clear();
    },
    limits,
    get stats() {
      return { enabled, ...lru.stats };
    },
  };
}

export type Cache = ReturnType<typeof createCache>;
