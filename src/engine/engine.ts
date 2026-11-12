/**
 * Engine: Redis-like semantics, type checks, expiration, cache coordination.
 */

import { KEY_TYPES } from '../storage/sqlite/schema.ts';
import { createKeysStorage } from '../storage/sqlite/keys.ts';
import { createStringsStorage } from '../storage/sqlite/strings.ts';
import { createHashesStorage } from '../storage/sqlite/hashes.ts';
import { createSetsStorage } from '../storage/sqlite/sets.ts';
import { createListsStorage } from '../storage/sqlite/lists.ts';
import { createZsetsStorage } from '../storage/sqlite/zsets.ts';
import { createUsageStorage } from '../storage/sqlite/usage.ts';
import { clearSearchData } from '../storage/sqlite/search.ts';
import { createBlockingManager } from '../blocking/manager.ts';
import { runInTransaction } from '../storage/sqlite/tx.ts';
import { matchPattern } from '../util/patterns.ts';
import { expectString, expectHash, expectSet, expectList, expectZset, typeName } from './validate.ts';
import { parseInteger, parseInteger64, numberIfSafe } from '../util/integers.ts';
import { asKey, asValue } from '../util/buffers.ts';
import type Database from '../storage/sqlite/driver.ts';
import type { Cache, CacheValues } from '../cache/cache.ts';
import type { BlockingManager } from '../blocking/manager.ts';
import type { KeyMeta } from '../storage/sqlite/keys.ts';


export interface EngineOptions {
  db: Database;
  cache?: Cache | null;
  clock?: () => number;
}

/** Keys, fields, members and values accept strings and are stored as Buffers. */
export type KeyInput = Buffer | string;
/** Raw numeric argument parsed by the engine. */
export type NumericInput = Buffer | string | number;

export type HashFieldExpireCondition = 'NX' | 'XX' | 'GT' | 'LT';

export interface SetOptions {
  expiresAt?: number | bigint | null;
  ex?: NumericInput | bigint;
  px?: NumericInput | bigint;
  exat?: NumericInput | bigint;
  pxat?: NumericInput | bigint;
  nx?: boolean;
  xx?: boolean;
  get?: boolean;
  keepttl?: boolean;
}

export interface HscanOptions {
  count?: number;
  match?: Buffer | string | null;
  noValues?: boolean;
}

export interface ScanOptions {
  count?: number;
}

export interface ZsetRangeOptions {
  withScores?: boolean;
}

export interface ZsetScoreRangeOptions {
  withScores?: boolean;
  offset?: number;
  limit?: number;
}

interface CacheMeta {
  version: number;
  expiresAt: number | bigint | null;
}

type CachedHash = CacheValues['hash'];
type CachedSet = CacheValues['set'];
type CachedList = CacheValues['list'];
type CachedZset = CacheValues['zset'];
/** [member, score text, numeric score] */
type CachedZsetEntry = CachedZset extends Map<string, infer E> ? E : never;
type CachedCollectionKind = 'set' | 'list' | 'zset';

interface MsetEntry {
  key: Buffer;
  value: Buffer;
  options: { existingMeta: KeyMeta | null; replaceForeignType?: boolean };
}

export function createEngine(opts: EngineOptions) {
  const { db, cache } = opts;
  const sourceClock = opts.clock ?? (() => Date.now());
  let scriptTime: number | null = null;
  const clock = () => scriptTime ?? sourceClock();
  const keys = createKeysStorage(db);
  const strings = createStringsStorage(db, keys);
  const hashes = createHashesStorage(db, keys, { clock });
  const sets = createSetsStorage(db, keys);
  const lists = createListsStorage(db, keys);
  const zsets = createZsetsStorage(db, keys);
  const usage = createUsageStorage(db);

  const CACHE_MISS = Symbol('cache-miss');

  // latin1 maps each byte to one char, so distinct keys stay distinct.
  function cacheKey(key: Buffer): string {
    return key.toString('latin1');
  }

  function invalidateCachedKey(key: Buffer): void {
    cache?.invalidate(cacheKey(key));
  }

  function cacheString(key: Buffer, value: Buffer | null | undefined, meta: Partial<CacheMeta> = {}): void {
    if (!cache || value == null) return;
    // Keep the cached copy private: engine callers receive mutable Buffers.
    cache.set(
      cacheKey(key),
      'string',
      Buffer.from(value),
      meta.version ?? 0,
      meta.expiresAt ?? null
    );
  }

  function readCachedString(key: Buffer): Buffer | null | typeof CACHE_MISS {
    if (!cache) return CACHE_MISS;
    const entry = cache.get(cacheKey(key));
    if (!entry || entry.kind !== 'string') return CACHE_MISS;
    if (entry.expiresAt != null && entry.expiresAt <= clock()) {
      invalidateCachedKey(key);
      keys.delete(key);
      return null;
    }
    return Buffer.from(entry.value);
  }

  function cacheHash(key: Buffer, flat: Buffer[], meta: CacheMeta): void {
    if (!cache) return;
    const fieldCount = flat.length / 2;
    const maxFields = cache.limits?.maxHashFields ?? 256;
    const maxBytes = cache.limits?.maxHashBytes ?? 256 * 1024;
    let bytes = 0;
    for (const item of flat) bytes += item.length;
    if (fieldCount > maxFields || bytes > maxBytes) {
      invalidateCachedKey(key);
      return;
    }

    const fields: CachedHash = new Map();
    for (let i = 0; i < flat.length; i += 2) {
      const field = Buffer.from(flat[i]);
      const value = Buffer.from(flat[i + 1]);
      fields.set(cacheKey(field), [field, value]);
    }
    cache.set(cacheKey(key), 'hash', fields, meta.version, meta.expiresAt);
  }

  function readCachedHash(key: Buffer): CachedHash | null | typeof CACHE_MISS {
    if (!cache) return CACHE_MISS;
    const entry = cache.get(cacheKey(key));
    if (!entry || entry.kind !== 'hash') return CACHE_MISS;
    if (entry.expiresAt != null && entry.expiresAt <= clock()) {
      invalidateCachedKey(key);
      keys.delete(key);
      return null;
    }
    return entry.value;
  }

  function copyCachedHashFlat(fields: CachedHash): Buffer[] {
    const flat: Buffer[] = [];
    for (const [field, value] of fields.values()) {
      flat.push(Buffer.from(field), Buffer.from(value));
    }
    return flat;
  }

  function readCachedHashField(fields: CachedHash, field: Buffer): Buffer | null {
    const pair = fields.get(cacheKey(field));
    return pair ? Buffer.from(pair[1]) : null;
  }

  function readCachedCollection<K extends CachedCollectionKind>(
    key: Buffer,
    kind: K
  ): CacheValues[K] | null | typeof CACHE_MISS {
    if (!cache) return CACHE_MISS;
    const entry = cache.get(cacheKey(key));
    if (!entry || entry.kind !== kind) return CACHE_MISS;
    if (entry.expiresAt != null && entry.expiresAt <= clock()) {
      invalidateCachedKey(key);
      keys.delete(key);
      return null;
    }
    return entry.value as CacheValues[K];
  }

  function cacheSet(key: Buffer, members: Buffer[], meta: CacheMeta): void {
    if (!cache) return;
    const maxMembers = cache.limits?.maxSetMembers ?? 256;
    const maxBytes = cache.limits?.maxSetBytes ?? 256 * 1024;
    let bytes = 0;
    for (const member of members) bytes += member.length;
    if (members.length > maxMembers || bytes > maxBytes) {
      invalidateCachedKey(key);
      return;
    }

    const cachedMembers: CachedSet = new Map();
    for (const member of members) {
      const copy = Buffer.from(member);
      cachedMembers.set(cacheKey(copy), copy);
    }
    cache.set(cacheKey(key), 'set', cachedMembers, meta.version, meta.expiresAt);
  }

  function copyCachedSet(members: CachedSet): Buffer[] {
    return Array.from(members.values(), (member) => Buffer.from(member));
  }

  function randomCachedSetMembers(members: CachedSet, count: number | null): Buffer | Buffer[] | null {
    const values = Array.from(members.values());
    if (values.length === 0) return count != null && count !== 1 ? [] : null;
    const c = count == null ? 1 : count;
    if (c === 1) return Buffer.from(values[Math.floor(Math.random() * values.length)]);
    if (c > 0) {
      const shuffled = values.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled.slice(0, Math.min(c, shuffled.length)).map((member) => Buffer.from(member));
    }
    const out: Buffer[] = [];
    for (let i = 0; i < -c; i++) {
      out.push(Buffer.from(values[Math.floor(Math.random() * values.length)]));
    }
    return out;
  }

  function cacheList(key: Buffer, values: Buffer[], meta: CacheMeta): void {
    if (!cache) return;
    const maxItems = cache.limits?.maxListItems ?? 256;
    const maxBytes = cache.limits?.maxListBytes ?? 256 * 1024;
    let bytes = 0;
    for (const value of values) bytes += value.length;
    if (values.length > maxItems || bytes > maxBytes) {
      invalidateCachedKey(key);
      return;
    }
    cache.set(
      cacheKey(key),
      'list',
      values.map((value) => Buffer.from(value)),
      meta.version,
      meta.expiresAt
    );
  }

  // Keep the same rank clamping used by the SQLite list storage so cache hits
  // and misses have identical behavior for every supported index shape.
  function cachedListRange(values: CachedList, start: number, stop: number): Buffer[] {
    const len = values.length;
    if (len === 0) return [];
    const s = start < 0 ? Math.max(0, len + start) : start;
    let e = stop < 0 ? len + stop : stop;
    if (s > e || s >= len) return [];
    e = Math.min(e, len - 1);
    return values.slice(s, e + 1).map((value) => Buffer.from(value));
  }

  function cachedListIndex(values: CachedList, index: number): Buffer | null {
    const i = index < 0 ? values.length + index : index;
    return i < 0 || i >= values.length ? null : Buffer.from(values[i]);
  }

  function cacheZset(key: Buffer, flat: Array<Buffer | string>, meta: CacheMeta): void {
    if (!cache) return;
    const maxMembers = cache.limits?.maxZsetMembers ?? 256;
    const maxBytes = cache.limits?.maxZsetBytes ?? 256 * 1024;
    const memberCount = flat.length / 2;
    let bytes = 0;
    for (let i = 0; i < flat.length; i += 2) {
      bytes += (flat[i] as Buffer).length + Buffer.byteLength(String(flat[i + 1]));
    }
    if (memberCount > maxMembers || bytes > maxBytes) {
      invalidateCachedKey(key);
      return;
    }

    // Map insertion order is the canonical score/member ascending order.
    const entries: CachedZset = new Map();
    for (let i = 0; i < flat.length; i += 2) {
      const member = Buffer.from(flat[i] as Buffer);
      const score = String(flat[i + 1]);
      entries.set(cacheKey(member), [member, score, Number(score)]);
    }
    cache.set(cacheKey(key), 'zset', entries, meta.version, meta.expiresAt);
  }

  function formatCachedZset(entries: CachedZsetEntry[], withScores: boolean | undefined): Array<Buffer | string> {
    const out: Array<Buffer | string> = [];
    for (const [member, score] of entries) {
      out.push(Buffer.from(member));
      if (withScores) out.push(score);
    }
    return out;
  }

  function cachedZsetRange(
    entries: CachedZset,
    start: number,
    stop: number,
    { reverse = false, withScores = false }: { reverse?: boolean; withScores?: boolean } = {}
  ): Array<Buffer | string> {
    const ordered = Array.from(entries.values());
    if (reverse) ordered.reverse();
    const len = ordered.length;
    if (len === 0) return [];

    let s: number;
    let e: number;
    if (!reverse && start >= 0 && stop >= 0) {
      if (start > stop) return [];
      s = start;
      e = stop;
    } else {
      s = start >= 0 ? start : Math.max(0, len + start);
      e = stop >= 0 ? stop : len + stop;
      if (s > e || s >= len) return [];
      e = Math.min(e, len - 1);
    }
    return formatCachedZset(ordered.slice(s, e + 1), withScores);
  }

  function cachedZsetScoreRange(
    entries: CachedZset,
    min: number,
    max: number,
    options: ZsetScoreRangeOptions & { reverse?: boolean } = {}
  ): Array<Buffer | string> {
    let ordered = Array.from(entries.values()).filter((entry) => entry[2] >= min && entry[2] <= max);
    if (options.reverse) ordered.reverse();
    const offset = options.offset ?? 0;
    if (offset < 0) return [];
    const limit = options.limit;
    if (limit != null && limit >= 0) ordered = ordered.slice(offset, offset + limit);
    else ordered = ordered.slice(offset);
    return formatCachedZset(ordered, options.withScores);
  }

  function cachedZsetRank(entries: CachedZset, member: Buffer, reverse = false): number | null {
    const memberKey = cacheKey(member);
    let index = 0;
    for (const key of entries.keys()) {
      if (key === memberKey) return reverse ? entries.size - index - 1 : index;
      index++;
    }
    return null;
  }

  function versionAfterWrite(meta: { version: number } | null | undefined): number {
    return meta ? meta.version + 1 : 1;
  }

  function _incrBy(key: KeyInput, delta: number): number {
    const k = asKey(key);
    const cached = readCachedString(k);
    const meta = getKeyMeta(k);
    if (meta) expectString(meta);
    const cur = meta
      ? (cached !== CACHE_MISS ? cached : strings.get(k))
      : null;
    const num = cur == null ? 0 : parseInt(cur.toString('utf8'), 10);
    if (Number.isNaN(num)) throw new Error('ERR value is not an integer or out of range');
    const next = num + delta;
    const value = Buffer.from(String(next), 'utf8');
    strings.set(k, value, { existingMeta: meta });
    cacheString(k, value, { version: versionAfterWrite(meta), expiresAt: null });
    return next;
  }

  function getKeyMeta(key: KeyInput, now: number = clock()): KeyMeta | null {
    const k = Buffer.isBuffer(key) ? key : asKey(key);
    const meta = keys.get(k);
    if (meta && meta.expiresAt != null && meta.expiresAt <= now) {
      keys.delete(k);
      invalidateCachedKey(k);
      return null;
    }
    return meta;
  }

  function readString(key: KeyInput, { wrongTypeAsNull = false }: { wrongTypeAsNull?: boolean } = {}): Buffer | null {
    const k = asKey(key);
    const cached = readCachedString(k);
    if (cached !== CACHE_MISS) return cached;

    const meta = getKeyMeta(k);
    if (!meta) return null;
    if (wrongTypeAsNull && meta.type !== KEY_TYPES.STRING) return null;
    expectString(meta);

    const value = strings.get(k);
    cacheString(k, value, meta);
    return value;
  }

  const engine = {
    get(key: KeyInput) {
      return readString(key);
    },

    strlen(key: KeyInput) {
      const v = readString(key);
      return v ? v.length : 0;
    },

    set(key: KeyInput, value: KeyInput, options: SetOptions = {}) {
      const k = asKey(key);
      const v = asValue(value);
      let writtenMeta: KeyMeta | null | undefined;
      // Acquire the write lock before reading the condition, including across connections.
      const result = db.transaction(() => {
        const now = clock();
        let expiresAt = options.expiresAt ?? null;
        for (const option of ['ex', 'px', 'exat', 'pxat'] as const) {
          if (options[option] == null) continue;
          const amount = parseInteger64(options[option]!);
          let expiration = amount * (option === 'ex' || option === 'exat' ? 1000n : 1n);
          if (option === 'ex' || option === 'px') expiration += BigInt(now);
          if (amount <= 0n || expiration > 9223372036854775807n) {
            throw new Error("ERR invalid expire time in 'set' command");
          }
          expiresAt = numberIfSafe(expiration);
        }
        const existingMeta = getKeyMeta(k, now);
        const wantsPrevious = options.get === true;
        if (wantsPrevious && existingMeta) expectString(existingMeta);
        // Read the same database snapshot as the condition, not a process-local cache.
        const previous = wantsPrevious && existingMeta ? strings.get(k) : null;
        if ((options.nx === true && existingMeta != null)
          || (options.xx === true && existingMeta == null)) return { written: false, previous };
        if (options.keepttl === true) expiresAt = existingMeta ? existingMeta.expiresAt : null;
        strings.set(k, v, { expiresAt, existingMeta, replaceForeignType: true });
        writtenMeta = keys.get(k);
        return { written: true, previous };
      }).immediate();
      if (result.written) cacheString(k, v, writtenMeta!);
      return result;
    },

    setnx(key: KeyInput, value: KeyInput): number {
      const { written } = engine.set(key, value, { nx: true });
      return written ? 1 : 0;
    },

    mset(pairs: KeyInput[]) {
      const entriesByKey = new Map<string, MsetEntry>();
      for (let i = 0; i < pairs.length; i += 2) {
        const k = asKey(pairs[i]);
        const mapKey = cacheKey(k);
        const existingEntry = entriesByKey.get(mapKey);
        if (existingEntry) {
          existingEntry.value = asValue(pairs[i + 1]);
        } else {
          entriesByKey.set(mapKey, {
            key: k,
            value: asValue(pairs[i + 1]),
            options: { existingMeta: getKeyMeta(k), replaceForeignType: true },
          });
        }
      }
      const entries = Array.from(entriesByKey.values());
      strings.setMultiple(entries);
      for (const entry of entries) {
        const { existingMeta } = entry.options;
        cacheString(entry.key, entry.value, {
          version: versionAfterWrite(existingMeta),
          expiresAt: null,
        });
      }
    },

    msetnx(pairs: KeyInput[]) {
      const entriesByKey = new Map<string, MsetEntry>();
      for (let i = 0; i < pairs.length; i += 2) {
        const key = asKey(pairs[i]);
        entriesByKey.set(cacheKey(key), {
          key,
          value: asValue(pairs[i + 1]),
          options: { existingMeta: null },
        });
      }
      const entries = Array.from(entriesByKey.values());
      const written = runInTransaction(db, () => {
        for (const entry of entries) {
          if (getKeyMeta(entry.key)) return false;
        }
        strings.setMultiple(entries);
        return true;
      });
      if (!written) return 0;
      for (const entry of entries) {
        cacheString(entry.key, entry.value, { version: 1, expiresAt: null });
      }
      return 1;
    },

    mget(keysList: KeyInput[]) {
      return keysList.map((key) => readString(key, { wrongTypeAsNull: true }));
    },

    del(keysToDelete: KeyInput[]) {
      let n = 0;
      for (const key of keysToDelete) {
        const k = asKey(key);
        if (keys.get(k)) {
          keys.delete(k);
          n++;
        }
        invalidateCachedKey(k);
      }
      return n;
    },

    exists(keysToCheck: KeyInput[]) {
      let n = 0;
      for (const key of keysToCheck) {
        if (getKeyMeta(key)) n++;
      }
      return n;
    },

    dbsize() {
      return keys.countLive(clock());
    },

    flushDatabase() {
      runInTransaction(db, () => {
        keys.deleteAll();
        clearSearchData(db);
      });
      cache?.clear();
    },

    expire(key: KeyInput, seconds: number) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return false;
      const expiresAt = clock() + seconds * 1000;
      keys.setExpires(k, expiresAt);
      invalidateCachedKey(k);
      return true;
    },

    pexpire(key: KeyInput, milliseconds: number) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return false;
      const expiresAt = clock() + milliseconds;
      keys.setExpires(k, expiresAt);
      invalidateCachedKey(k);
      return true;
    },

    ttl(key: KeyInput) {
      const meta = getKeyMeta(key);
      if (!meta) return -2;
      if (meta.expiresAt == null) return -1;
      const ms = typeof meta.expiresAt === 'bigint' ? meta.expiresAt - BigInt(clock()) : meta.expiresAt - clock();
      if (ms <= 0) return -2;
      return typeof ms === 'bigint' ? numberIfSafe(ms / 1000n) : Math.floor(ms / 1000);
    },

    pttl(key: KeyInput) {
      const meta = getKeyMeta(key);
      if (!meta) return -2;
      if (meta.expiresAt == null) return -1;
      const ms = typeof meta.expiresAt === 'bigint' ? meta.expiresAt - BigInt(clock()) : meta.expiresAt - clock();
      if (ms <= 0) return -2;
      return numberIfSafe(ms);
    },

    persist(key: KeyInput) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return false;
      keys.setExpires(k, null);
      invalidateCachedKey(k);
      return true;
    },

    incr(key: KeyInput) {
      return _incrBy(key, 1);
    },

    decr(key: KeyInput) {
      return _incrBy(key, -1);
    },

    incrby(key: KeyInput, delta: number) {
      return _incrBy(key, delta);
    },

    decrby(key: KeyInput, delta: number) {
      return _incrBy(key, -delta);
    },

    hset(key: KeyInput, ...pairs: KeyInput[]) {
      const k = asKey(key);
      const existingMeta = getKeyMeta(k);
      const keyValuePairs = pairs.map((p) => (Buffer.isBuffer(p) ? p : asValue(p)));
      const added = keyValuePairs.length === 2
        ? hashes.set(k, keyValuePairs[0], keyValuePairs[1], { existingMeta })
        : hashes.setMultiple(k, keyValuePairs, { existingMeta });
      invalidateCachedKey(k);
      return added;
    },

    hsetnx(key: KeyInput, field: KeyInput, value: KeyInput) {
      const k = asKey(key);
      const existingMeta = getKeyMeta(k);
      const added = hashes.setIfAbsent(k, asKey(field), asValue(value), { existingMeta });
      if (added) invalidateCachedKey(k);
      return added;
    },

    hget(key: KeyInput, field: KeyInput): Buffer | null {
      const k = asKey(key);
      const f = asKey(field);
      const cached = readCachedHash(k);
      if (cached !== CACHE_MISS) return cached ? readCachedHashField(cached, f) : null;
      const meta = getKeyMeta(k);
      if (!meta) return null;
      expectHash(meta);
      return hashes.get(k, f);
    },

    hmget(key: KeyInput, fields: KeyInput[]) {
      const k = asKey(key);
      const fieldBuffers = fields.map((f) => asKey(f));
      const cached = readCachedHash(k);
      if (cached !== CACHE_MISS) {
        if (!cached) return fields.map(() => null);
        return fieldBuffers.map((f) => readCachedHashField(cached, f));
      }
      const meta = getKeyMeta(k);
      if (!meta) return fields.map(() => null);
      expectHash(meta);
      return fieldBuffers.map((f) => hashes.get(k, f));
    },

    hgetall(key: KeyInput): Buffer[] {
      const k = asKey(key);
      const cached = readCachedHash(k);
      if (cached !== CACHE_MISS) return cached ? copyCachedHashFlat(cached) : [];
      const meta = getKeyMeta(k);
      if (!meta) return [];
      expectHash(meta);
      const { values, hasFieldTtl } = hashes.getAllWithMeta(k);
      if (!hasFieldTtl) cacheHash(k, values, meta);
      return values;
    },

    hkeys(key: KeyInput): Buffer[] {
      const flat = this.hgetall(key);
      const out: Buffer[] = [];
      for (let i = 0; i < flat.length; i += 2) out.push(flat[i]);
      return out;
    },

    hvals(key: KeyInput): Buffer[] {
      const flat = this.hgetall(key);
      const out: Buffer[] = [];
      for (let i = 1; i < flat.length; i += 2) out.push(flat[i]);
      return out;
    },

    hstrlen(key: KeyInput, field: KeyInput): number {
      const value = this.hget(key, field);
      return value == null ? 0 : value.length;
    },

    hscan(key: KeyInput, cursor: number, options: HscanOptions = {}) {
      const k = asKey(key);
      const offset = Number(cursor);
      const count = options.count ?? 10;
      const meta = getKeyMeta(k);
      if (!meta) return { cursor: 0, values: [] };
      expectHash(meta);

      const flat = hashes.scan(k, count, offset);
      const values: Buffer[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        if (options.match == null || matchPattern(flat[i], options.match)) {
          values.push(flat[i]);
          if (!options.noValues) values.push(flat[i + 1]);
        }
      }
      const scanned = flat.length / 2;
      const nextCursor = scanned < count ? 0 : offset + scanned;
      return {
        cursor: nextCursor,
        values,
      };
    },

    hrandfield(key: KeyInput, count: number | null = null, { withValues = false }: { withValues?: boolean } = {}) {
      const k = asKey(key);
      const meta = getKeyMeta(k);
      if (!meta) return count == null ? null : [];
      expectHash(meta);

      let entries: Array<[Buffer, Buffer]>;
      const cached = readCachedHash(k);
      if (cached !== CACHE_MISS) {
        entries = cached ? [...cached.values()] : [];
      } else {
        const { values, hasFieldTtl } = hashes.getAllWithMeta(k);
        if (!hasFieldTtl) cacheHash(k, values, meta);
        entries = [];
        for (let i = 0; i < values.length; i += 2) entries.push([values[i], values[i + 1]]);
      }
      if (entries.length === 0) return count == null ? null : [];

      if (count == null) {
        return Buffer.from(entries[Math.floor(Math.random() * entries.length)][0]);
      }

      let selected: Array<[Buffer, Buffer]>;
      if (count >= 0) {
        const shuffled = entries.slice();
        const limit = Math.min(count, shuffled.length);
        for (let i = 0; i < limit; i++) {
          const j = i + Math.floor(Math.random() * (shuffled.length - i));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        selected = shuffled.slice(0, limit);
      } else {
        selected = [];
        for (let i = 0; i < -count; i++) {
          selected.push(entries[Math.floor(Math.random() * entries.length)]);
        }
      }
      const result = withValues ? selected.flat() : selected.map(([field]) => field);
      return result.map((value) => Buffer.from(value));
    },

    hdel(key: KeyInput, fields: KeyInput[]) {
      const k = asKey(key);
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectHash(meta);
      const deleted = hashes.delete(k, fields.map((f) => asKey(f)), { existingMeta: meta });
      invalidateCachedKey(k);
      return deleted;
    },

    hlen(key: KeyInput) {
      const k = asKey(key);
      const cached = readCachedHash(k);
      if (cached !== CACHE_MISS) return cached ? cached.size : 0;
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectHash(meta);
      return hashes.count(k, { existingMeta: meta });
    },

    hexists(key: KeyInput, field: KeyInput): number {
      const v = this.hget(key, field);
      return v != null ? 1 : 0;
    },

    hincrby(key: KeyInput, field: KeyInput, amount: NumericInput) {
      const k = asKey(key);
      const existingMeta = getKeyMeta(k);
      const amt = parseInt(Buffer.isBuffer(amount) ? amount.toString() : String(amount), 10);
      if (Number.isNaN(amt)) throw new Error('ERR value is not an integer or out of range');
      const next = hashes.incr(k, asKey(field), amt, { existingMeta });
      invalidateCachedKey(k);
      return next;
    },

    hincrbyfloat(key: KeyInput, field: KeyInput, amount: NumericInput) {
      const k = asKey(key);
      const existingMeta = getKeyMeta(k);
      const text = Buffer.isBuffer(amount) ? amount.toString('utf8') : String(amount);
      const number = Number(text);
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(number)) {
        throw new Error('ERR value is not a valid float');
      }
      const next = hashes.incrFloat(k, asKey(field), number, { existingMeta });
      invalidateCachedKey(k);
      return next;
    },

    /**
     * HEXPIRE: apply absolute expiresAtMs to each hash field with optional NX/XX/GT/LT.
     * Returns an array of integers per spec: -2 (missing), 0 (cond), 1 (set), 2 (deleted).
     */
    hexpire(
      key: KeyInput,
      expiresAtMs: number,
      fields: KeyInput[],
      { condition = null }: { condition?: HashFieldExpireCondition | null } = {}
    ) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return fields.map(() => -2);
      expectHash(meta);
      try {
        return runInTransaction(db, () => (
          fields.map((f) => hashes.setFieldExpire(k, asKey(f), expiresAtMs, { condition }))
        ));
      } finally {
        invalidateCachedKey(k);
      }
    },

    /**
     * HTTL: seconds remaining per field. -2 missing, -1 no TTL, else seconds.
     */
    httl(key: KeyInput, fields: KeyInput[]) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return fields.map(() => -2);
      expectHash(meta);
      let expired = false;
      const values = fields.map((f) => {
        const result = hashes.getFieldTtl(k, asKey(f));
        if (result.expired) expired = true;
        if (result.value < 0) return result.value;
        return Math.floor(result.value / 1000);
      });
      if (expired) invalidateCachedKey(k);
      return values;
    },

    hpttl(key: KeyInput, fields: KeyInput[]) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return fields.map(() => -2);
      expectHash(meta);
      let expired = false;
      const values = fields.map((field) => {
        const result = hashes.getFieldTtl(k, asKey(field));
        if (result.expired) expired = true;
        return result.value;
      });
      if (expired) invalidateCachedKey(k);
      return values;
    },

    hexpiretime(key: KeyInput, fields: KeyInput[], { milliseconds = false }: { milliseconds?: boolean } = {}) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return fields.map(() => -2);
      expectHash(meta);
      let expired = false;
      const values = fields.map((field) => {
        const result = hashes.getFieldExpireAt(k, asKey(field));
        if (result.expired) expired = true;
        if (result.value < 0 || milliseconds) return result.value;
        return Math.floor(result.value / 1000);
      });
      if (expired) invalidateCachedKey(k);
      return values;
    },

    /**
     * HPERSIST: clear field TTL. -2 missing, -1 no TTL, 1 cleared.
     */
    hpersist(key: KeyInput, fields: KeyInput[]) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return fields.map(() => -2);
      expectHash(meta);
      try {
        return runInTransaction(db, () => fields.map((f) => hashes.persistField(k, asKey(f))));
      } finally {
        invalidateCachedKey(k);
      }
    },

    sadd(key: KeyInput, ...members: KeyInput[]) {
      const k = asKey(key);
      getKeyMeta(key);
      const buf = members.map((m) => (Buffer.isBuffer(m) ? m : asKey(m)));
      const added = sets.add(k, buf);
      invalidateCachedKey(k);
      return added;
    },

    srem(key: KeyInput, members: KeyInput[]) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectSet(meta);
      const removed = sets.remove(k, members.map((m) => asKey(m)));
      invalidateCachedKey(k);
      return removed;
    },

    smembers(key: KeyInput) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'set');
      if (cached !== CACHE_MISS) return cached ? copyCachedSet(cached) : [];
      const meta = getKeyMeta(k);
      if (!meta) return [];
      expectSet(meta);
      const members = sets.members(k);
      cacheSet(k, members, meta);
      return members;
    },

    sismember(key: KeyInput, member: KeyInput) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'set');
      if (cached !== CACHE_MISS) return cached && cached.has(cacheKey(asKey(member))) ? 1 : 0;
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectSet(meta);
      return sets.has(k, asKey(member)) ? 1 : 0;
    },

    smismember(key: KeyInput, members: KeyInput[]) {
      const k = asKey(key);
      const memberBuffers = members.map((member) => asKey(member));
      const cached = readCachedCollection(k, 'set');
      if (cached !== CACHE_MISS) {
        return memberBuffers.map((member) => cached && cached.has(cacheKey(member)) ? 1 : 0);
      }
      const meta = getKeyMeta(k);
      if (!meta) return members.map(() => 0);
      expectSet(meta);
      return memberBuffers.map((member) => sets.has(k, member) ? 1 : 0);
    },

    scard(key: KeyInput) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'set');
      if (cached !== CACHE_MISS) return cached ? cached.size : 0;
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectSet(meta);
      return sets.count(k);
    },

    spop(key: KeyInput, count: number | null = null) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return count != null && count !== 1 ? [] : null;
      expectSet(meta);
      const popped = sets.popRandom(k, count);
      invalidateCachedKey(k);
      return popped;
    },

    srandmember(key: KeyInput, count: number | null = null) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'set');
      if (cached !== CACHE_MISS) return cached ? randomCachedSetMembers(cached, count) : null;
      const meta = getKeyMeta(k);
      if (!meta) return count != null && count !== 1 ? [] : null;
      expectSet(meta);
      return sets.getRandomMembers(k, count);
    },

    lpush(key: KeyInput, ...values: KeyInput[]) {
      const k = asKey(key);
      getKeyMeta(key);
      const buf = values.map((v) => (Buffer.isBuffer(v) ? v : asValue(v)));
      const n = lists.lpush(k, buf);
      invalidateCachedKey(k);
      if (this._blockingManager) this._blockingManager.wakeup(k);
      return n;
    },

    rpush(key: KeyInput, ...values: KeyInput[]) {
      const k = asKey(key);
      getKeyMeta(key);
      const buf = values.map((v) => (Buffer.isBuffer(v) ? v : asValue(v)));
      const n = lists.rpush(k, buf);
      invalidateCachedKey(k);
      if (this._blockingManager) this._blockingManager.wakeup(k);
      return n;
    },

    llen(key: KeyInput) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'list');
      if (cached !== CACHE_MISS) return cached ? cached.length : 0;
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectList(meta);
      return lists.llen(k);
    },

    lrange(key: KeyInput, start: NumericInput, stop: NumericInput) {
      const k = asKey(key);
      const s = parseInteger(start);
      const e = parseInteger(stop);
      const cached = readCachedCollection(k, 'list');
      if (cached !== CACHE_MISS) return cached ? cachedListRange(cached, s, e) : [];
      const meta = getKeyMeta(k);
      if (!meta) return [];
      expectList(meta);
      const values = lists.lrange(k, s, e);
      if (s === 0 && e === -1) cacheList(k, values, meta);
      return values;
    },

    lindex(key: KeyInput, index: NumericInput) {
      const k = asKey(key);
      const i = parseInteger(index);
      const cached = readCachedCollection(k, 'list');
      if (cached !== CACHE_MISS) return cached ? cachedListIndex(cached, i) : null;
      const meta = getKeyMeta(k);
      if (!meta) return null;
      expectList(meta);
      return lists.lindex(k, i);
    },

    lpop(key: KeyInput, count: number | null = null) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return count != null && count > 0 ? [] : null;
      expectList(meta);
      const popped = lists.lpop(k, count);
      invalidateCachedKey(k);
      return popped;
    },

    rpop(key: KeyInput, count: number | null = null) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return count != null && count > 0 ? [] : null;
      expectList(meta);
      const popped = lists.rpop(k, count);
      invalidateCachedKey(k);
      return popped;
    },

    lmpop(keysToCheck: KeyInput[], direction: string, count: number) {
      return runInTransaction(db, (): [Buffer, Buffer[]] | null => {
        for (const key of keysToCheck) {
          const k = asKey(key);
          const meta = getKeyMeta(k);
          if (!meta) continue;
          expectList(meta);
          // A positive count always pops an array.
          const values = direction === 'LEFT'
            ? lists.lpop(k, count) as Buffer[]
            : lists.rpop(k, count) as Buffer[];
          invalidateCachedKey(k);
          if (values.length > 0) return [k, values];
        }
        return null;
      });
    },

    lrem(key: KeyInput, count: NumericInput, element: KeyInput) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectList(meta);
      const c = parseInt(Buffer.isBuffer(count) ? count.toString() : String(count), 10);
      if (Number.isNaN(c)) throw new Error('ERR value is not an integer or out of range');
      const elem = Buffer.isBuffer(element) ? element : asValue(element);
      const removed = lists.lrem(k, c, elem);
      invalidateCachedKey(k);
      return removed;
    },

    lset(key: KeyInput, index: NumericInput, value: KeyInput) {
      const k = asKey(key);
      const i = parseInteger(index);
      const meta = getKeyMeta(key);
      if (!meta) throw new Error('ERR no such key');
      expectList(meta);
      const val = Buffer.isBuffer(value) ? value : asValue(value);
      lists.lset(k, i, val);
      invalidateCachedKey(k);
    },

    ltrim(key: KeyInput, start: NumericInput, stop: NumericInput) {
      const k = asKey(key);
      const s = parseInteger(start);
      const e = parseInteger(stop);
      const meta = getKeyMeta(key);
      if (!meta) return;
      expectList(meta);
      lists.ltrim(k, s, e);
      invalidateCachedKey(k);
    },

    zadd(key: KeyInput, scoreMemberPairs: KeyInput[]) {
      const k = asKey(key);
      getKeyMeta(key);
      const pairs: Array<{ score: number; member: Buffer }> = [];
      for (let i = 0; i < scoreMemberPairs.length; i += 2) {
        const scoreRaw = scoreMemberPairs[i];
        const memberRaw = scoreMemberPairs[i + 1];
        const score = parseFloat(Buffer.isBuffer(scoreRaw) ? scoreRaw.toString() : String(scoreRaw));
        if (Number.isNaN(score)) throw new Error('ERR value is not a valid float');
        const member = Buffer.isBuffer(memberRaw) ? memberRaw : asKey(memberRaw);
        pairs.push({ score, member });
      }
      const added = zsets.add(k, pairs);
      invalidateCachedKey(k);
      return added;
    },

    zrem(key: KeyInput, members: KeyInput[]) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectZset(meta);
      const removed = zsets.remove(k, members.map((m) => asKey(m)));
      invalidateCachedKey(k);
      return removed;
    },

    zcard(key: KeyInput) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) return cached ? cached.size : 0;
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectZset(meta);
      return zsets.count(k);
    },

    zscore(key: KeyInput, member: KeyInput) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) {
        const entry = cached?.get(cacheKey(asKey(member)));
        return entry ? entry[1] : null;
      }
      const meta = getKeyMeta(k);
      if (!meta) return null;
      expectZset(meta);
      return zsets.score(k, asKey(member));
    },

    zmscore(key: KeyInput, members: KeyInput[]) {
      const k = asKey(key);
      const memberBuffers = members.map((member) => asKey(member));
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) {
        return memberBuffers.map((member) => cached?.get(cacheKey(member))?.[1] ?? null);
      }
      const meta = getKeyMeta(k);
      if (!meta) return members.map(() => null);
      expectZset(meta);
      return memberBuffers.map((member) => zsets.score(k, member));
    },

    zmpop(keysToCheck: KeyInput[], direction: string, count: number) {
      return runInTransaction(db, (): [Buffer, Array<[Buffer, string]>] | null => {
        for (const key of keysToCheck) {
          const k = asKey(key);
          const meta = getKeyMeta(k);
          if (!meta) continue;
          expectZset(meta);
          const flat = direction === 'MIN'
            ? zsets.rangeByRank(k, 0, count - 1, { withScores: true })
            : zsets.rangeByRankReverse(k, 0, count - 1, { withScores: true });
          if (flat.length === 0) continue;
          const members: Buffer[] = [];
          const entries: Array<[Buffer, string]> = [];
          // WITHSCORES output alternates member Buffers and score strings.
          for (let i = 0; i < flat.length; i += 2) {
            members.push(flat[i] as Buffer);
            entries.push([flat[i] as Buffer, flat[i + 1] as string]);
          }
          zsets.remove(k, members);
          invalidateCachedKey(k);
          return [k, entries];
        }
        return null;
      });
    },

    zrange(key: KeyInput, start: number, stop: number, options: ZsetRangeOptions = {}) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) {
        return cached ? cachedZsetRange(cached, start, stop, { withScores: options.withScores }) : [];
      }
      const meta = getKeyMeta(k);
      if (!meta) return [];
      expectZset(meta);
      if (start === 0 && stop === -1) {
        const flat = zsets.rangeByRank(k, 0, -1, { withScores: true });
        cacheZset(k, flat, meta);
        if (options.withScores) return flat;
        return flat.filter((_, index) => index % 2 === 0);
      }
      return zsets.rangeByRank(k, start, stop, { withScores: options.withScores });
    },

    zrevrange(key: KeyInput, start: number, stop: number, options: ZsetRangeOptions = {}) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) {
        return cached ? cachedZsetRange(cached, start, stop, { reverse: true, withScores: options.withScores }) : [];
      }
      const meta = getKeyMeta(k);
      if (!meta) return [];
      expectZset(meta);
      if (start === 0 && stop === -1) {
        const flat = zsets.rangeByRank(k, 0, -1, { withScores: true });
        cacheZset(k, flat, meta);
        const entries: CachedZsetEntry[] = [];
        for (let i = 0; i < flat.length; i += 2) {
          entries.push([flat[i] as Buffer, String(flat[i + 1]), Number(flat[i + 1])]);
        }
        entries.reverse();
        return formatCachedZset(entries, options.withScores);
      }
      return zsets.rangeByRankReverse(k, start, stop, { withScores: options.withScores });
    },

    zrevrank(key: KeyInput, member: KeyInput) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) return cached ? cachedZsetRank(cached, asKey(member), true) : null;
      const meta = getKeyMeta(k);
      if (!meta) return null;
      expectZset(meta);
      return zsets.rankReverse(k, asKey(member));
    },

    zrank(key: KeyInput, member: KeyInput) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) return cached ? cachedZsetRank(cached, asKey(member)) : null;
      const meta = getKeyMeta(k);
      if (!meta) return null;
      expectZset(meta);
      return zsets.rank(k, asKey(member));
    },

    zrangebyscore(key: KeyInput, min: number, max: number, options: ZsetScoreRangeOptions = {}) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) {
        return cached ? cachedZsetScoreRange(cached, min, max, options) : [];
      }
      const meta = getKeyMeta(k);
      if (!meta) return [];
      expectZset(meta);
      return zsets.rangeByScore(k, min, max, {
        withScores: options.withScores,
        offset: options.offset ?? 0,
        limit: options.limit,
      });
    },

    zcount(key: KeyInput, min: number, max: number) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) {
        if (!cached) return 0;
        let count = 0;
        for (const entry of cached.values()) {
          if (entry[2] >= min && entry[2] <= max) count++;
        }
        return count;
      }
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectZset(meta);
      return zsets.countByScore(k, min, max);
    },

    zincrby(key: KeyInput, increment: NumericInput, member: KeyInput) {
      const k = asKey(key);
      getKeyMeta(key);
      const inc = parseFloat(Buffer.isBuffer(increment) ? increment.toString() : String(increment));
      if (Number.isNaN(inc)) throw new Error('ERR value is not a valid float');
      const score = zsets.incr(k, asKey(member), inc);
      invalidateCachedKey(k);
      return score;
    },

    zremrangebyrank(key: KeyInput, start: NumericInput, stop: NumericInput) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectZset(meta);
      const s = parseInt(Buffer.isBuffer(start) ? start.toString() : String(start), 10);
      const e = parseInt(Buffer.isBuffer(stop) ? stop.toString() : String(stop), 10);
      if (Number.isNaN(s) || Number.isNaN(e)) return 0;
      const removed = zsets.removeRangeByRank(k, s, e);
      invalidateCachedKey(k);
      return removed;
    },

    zremrangebyscore(key: KeyInput, min: NumericInput, max: NumericInput) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectZset(meta);
      const minNum = parseFloat(Buffer.isBuffer(min) ? min.toString() : String(min));
      const maxNum = parseFloat(Buffer.isBuffer(max) ? max.toString() : String(max));
      if (Number.isNaN(minNum) || Number.isNaN(maxNum)) throw new Error('ERR value is not a valid float');
      const removed = zsets.removeRangeByScore(k, minNum, maxNum);
      invalidateCachedKey(k);
      return removed;
    },

    zrevrangebyscore(key: KeyInput, max: number, min: number, options: ZsetScoreRangeOptions = {}) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) {
        return cached
          ? cachedZsetScoreRange(cached, min, max, { ...options, reverse: true })
          : [];
      }
      const meta = getKeyMeta(k);
      if (!meta) return [];
      expectZset(meta);
      return zsets.rangeByScoreReverse(k, max, min, {
        withScores: options.withScores,
        offset: options.offset ?? 0,
        limit: options.limit,
      });
    },

    type(key: KeyInput) {
      const meta = getKeyMeta(key);
      return typeName(meta);
    },

    /**
     * OBJECT IDLETIME: seconds since key was last written (updated_at).
     * Returns null if key does not exist (Redis: nil).
     */
    objectIdletime(key: KeyInput) {
      const meta = getKeyMeta(key);
      if (!meta || meta.updatedAt == null) return null;
      const elapsedMs = clock() - meta.updatedAt;
      return Math.floor(elapsedMs / 1000);
    },

    /**
     * MEMORY USAGE: bytes of key name plus stored payload. Null if key does not exist.
     */
    memoryUsage(key: KeyInput) {
      const k = asKey(key);
      const meta = getKeyMeta(k);
      if (!meta) return null;
      return usage.keyBytes(k, meta.type);
    },

    /** Keyspace summary for INFO: live keys, keys with TTL, mean TTL in ms. */
    keyspaceInfo() {
      const now = clock();
      const expiring = usage.expiring(now);
      return { keys: keys.countLive(now), expires: expiring.count, avgTtlMs: expiring.avgTtlMs };
    },

    databaseBytes() {
      return usage.databaseBytes();
    },

    scan(cursor: string | number, options: ScanOptions = {}) {
      const count = options.count ?? 10;
      const offset = parseInt(String(cursor), 10) || 0;
      const keysList = keys.scan(count, offset);
      const nextCursor = keysList.length < count ? 0 : offset + keysList.length;
      return { cursor: nextCursor, keys: keysList };
    },

    rename(key: KeyInput, newkey: KeyInput) {
      const k = asKey(key);
      const nk = asKey(newkey);
      const meta = getKeyMeta(key);
      if (!meta) throw new Error('ERR no such key');
      if (k.equals(nk)) return;
      runInTransaction(db, () => {
        if (keys.get(nk)) keys.delete(nk);
        keys.set(nk, meta.type, {
          expiresAt: meta.expiresAt,
          setCount: meta.type === KEY_TYPES.SET ? meta.setCount : undefined,
          hashCount: meta.type === KEY_TYPES.HASH ? meta.hashCount : undefined,
          zsetCount: meta.type === KEY_TYPES.ZSET ? meta.zsetCount : undefined,
          existingMeta: null,
        });
        switch (meta.type) {
          case KEY_TYPES.STRING:
            strings.copyKey(k, nk);
            break;
          case KEY_TYPES.HASH:
            hashes.copyKey(k, nk);
            break;
          case KEY_TYPES.SET:
            sets.copyKey(k, nk);
            break;
          case KEY_TYPES.LIST:
            lists.copyKey(k, nk);
            break;
          case KEY_TYPES.ZSET:
            zsets.copyKey(k, nk);
            break;
          default:
            throw new Error('ERR unknown key type');
        }
        keys.delete(k);
      });
      invalidateCachedKey(k);
      invalidateCachedKey(nk);
    },

    runScript<T>(fn: () => T): T {
      if (scriptTime !== null) throw new Error('ERR recursive scripting is not allowed');
      scriptTime = sourceClock();
      this._blockingManager!.deferWakeups();
      try {
        return fn();
      } finally {
        scriptTime = null;
        this._blockingManager!.flushWakeups();
      }
    },

    /**
     * Run fn in one write transaction (nested engine transactions become savepoints).
     * On failure nothing fn wrote is kept, so the cache is cleared with it.
     */
    runBatch<T>(fn: () => T): T {
      try {
        return db.transaction(fn).immediate();
      } catch (err) {
        cache?.clear();
        throw err;
      }
    },

    // Expose for storage/commands that need direct access
    _db: db,
    _cache: cache ?? null,
    _keys: keys,
    _strings: strings,
    _hashes: hashes,
    _sets: sets,
    _lists: lists,
    _zsets: zsets,
    _clock: clock,
    _blockingManager: null as BlockingManager | null,
  };
  engine._blockingManager = createBlockingManager(engine, { clock });
  return engine;
}

export { KEY_TYPES };

export type Engine = ReturnType<typeof createEngine>;
