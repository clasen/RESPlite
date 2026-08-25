/**
 * Engine: Redis-like semantics, type checks, expiration, cache coordination.
 */

import { KEY_TYPES } from '../storage/sqlite/schema.js';
import { createKeysStorage } from '../storage/sqlite/keys.js';
import { createStringsStorage } from '../storage/sqlite/strings.js';
import { createHashesStorage } from '../storage/sqlite/hashes.js';
import { createSetsStorage } from '../storage/sqlite/sets.js';
import { createListsStorage } from '../storage/sqlite/lists.js';
import { createZsetsStorage } from '../storage/sqlite/zsets.js';
import { clearSearchData } from '../storage/sqlite/search.js';
import { createBlockingManager } from '../blocking/manager.js';
import { runInTransaction } from '../storage/sqlite/tx.js';
import { expectString, expectHash, expectSet, expectList, expectZset, typeName } from './validate.js';
import { asKey, asValue } from '../util/buffers.js';

export function createEngine(opts = {}) {
  const { db, cache } = opts;
  const clock = opts.clock ?? (() => Date.now());
  const keys = createKeysStorage(db);
  const strings = createStringsStorage(db, keys);
  const hashes = createHashesStorage(db, keys, { clock });
  const sets = createSetsStorage(db, keys);
  const lists = createListsStorage(db, keys);
  const zsets = createZsetsStorage(db, keys);

  const CACHE_MISS = Symbol('cache-miss');

  function cacheKey(key) {
    return key.toString('base64');
  }

  function invalidateCachedKey(key) {
    cache?.invalidate(cacheKey(key));
  }

  function cacheString(key, value, meta = {}) {
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

  function readCachedString(key) {
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

  function cacheHash(key, flat, meta) {
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

    const fields = new Map();
    for (let i = 0; i < flat.length; i += 2) {
      const field = Buffer.from(flat[i]);
      const value = Buffer.from(flat[i + 1]);
      fields.set(cacheKey(field), [field, value]);
    }
    cache.set(cacheKey(key), 'hash', fields, meta.version, meta.expiresAt);
  }

  function readCachedHash(key) {
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

  function copyCachedHashFlat(fields) {
    const flat = [];
    for (const [field, value] of fields.values()) {
      flat.push(Buffer.from(field), Buffer.from(value));
    }
    return flat;
  }

  function readCachedHashField(fields, field) {
    const pair = fields.get(cacheKey(field));
    return pair ? Buffer.from(pair[1]) : null;
  }

  function readCachedCollection(key, kind) {
    if (!cache) return CACHE_MISS;
    const entry = cache.get(cacheKey(key));
    if (!entry || entry.kind !== kind) return CACHE_MISS;
    if (entry.expiresAt != null && entry.expiresAt <= clock()) {
      invalidateCachedKey(key);
      keys.delete(key);
      return null;
    }
    return entry.value;
  }

  function cacheSet(key, members, meta) {
    if (!cache) return;
    const maxMembers = cache.limits?.maxSetMembers ?? 256;
    const maxBytes = cache.limits?.maxSetBytes ?? 256 * 1024;
    let bytes = 0;
    for (const member of members) bytes += member.length;
    if (members.length > maxMembers || bytes > maxBytes) {
      invalidateCachedKey(key);
      return;
    }

    const cachedMembers = new Map();
    for (const member of members) {
      const copy = Buffer.from(member);
      cachedMembers.set(cacheKey(copy), copy);
    }
    cache.set(cacheKey(key), 'set', cachedMembers, meta.version, meta.expiresAt);
  }

  function copyCachedSet(members) {
    return Array.from(members.values(), (member) => Buffer.from(member));
  }

  function randomCachedSetMembers(members, count) {
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
    const out = [];
    for (let i = 0; i < -c; i++) {
      out.push(Buffer.from(values[Math.floor(Math.random() * values.length)]));
    }
    return out;
  }

  function cacheList(key, values, meta) {
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
  function cachedListRange(values, start, stop) {
    const len = values.length;
    if (len === 0) return [];
    const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len - 1);
    const e = stop < 0 ? Math.max(0, len + stop) : Math.min(stop, len - 1);
    if (s > e) return [];
    return values.slice(s, e + 1).map((value) => Buffer.from(value));
  }

  function cachedListIndex(values, index) {
    const i = index < 0 ? values.length + index : index;
    return i < 0 || i >= values.length ? null : Buffer.from(values[i]);
  }

  function cacheZset(key, flat, meta) {
    if (!cache) return;
    const maxMembers = cache.limits?.maxZsetMembers ?? 256;
    const maxBytes = cache.limits?.maxZsetBytes ?? 256 * 1024;
    const memberCount = flat.length / 2;
    let bytes = 0;
    for (let i = 0; i < flat.length; i += 2) {
      bytes += flat[i].length + Buffer.byteLength(String(flat[i + 1]));
    }
    if (memberCount > maxMembers || bytes > maxBytes) {
      invalidateCachedKey(key);
      return;
    }

    // Map insertion order is the canonical score/member ascending order.
    const entries = new Map();
    for (let i = 0; i < flat.length; i += 2) {
      const member = Buffer.from(flat[i]);
      const score = String(flat[i + 1]);
      entries.set(cacheKey(member), [member, score, Number(score)]);
    }
    cache.set(cacheKey(key), 'zset', entries, meta.version, meta.expiresAt);
  }

  function formatCachedZset(entries, withScores) {
    const out = [];
    for (const [member, score] of entries) {
      out.push(Buffer.from(member));
      if (withScores) out.push(score);
    }
    return out;
  }

  function cachedZsetRange(entries, start, stop, { reverse = false, withScores = false } = {}) {
    const ordered = Array.from(entries.values());
    if (reverse) ordered.reverse();
    const len = ordered.length;
    if (len === 0) return [];

    let s;
    let e;
    if (!reverse && start >= 0 && stop >= 0) {
      if (start > stop) return [];
      s = start;
      e = stop;
    } else {
      s = start >= 0 ? start : Math.max(0, len + start);
      e = stop >= 0 ? stop : Math.max(0, len + stop);
      if (s > e) return [];
      s = Math.min(s, len - 1);
      e = Math.min(e, len - 1);
    }
    return formatCachedZset(ordered.slice(s, e + 1), withScores);
  }

  function cachedZsetScoreRange(entries, min, max, options = {}) {
    let ordered = Array.from(entries.values()).filter((entry) => entry[2] >= min && entry[2] <= max);
    if (options.reverse) ordered.reverse();
    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit;
    if (limit != null && limit >= 0) ordered = ordered.slice(offset, offset + limit);
    else ordered = ordered.slice(offset);
    return formatCachedZset(ordered, options.withScores);
  }

  function cachedZsetRank(entries, member, reverse = false) {
    const memberKey = cacheKey(member);
    let index = 0;
    for (const key of entries.keys()) {
      if (key === memberKey) return reverse ? entries.size - index - 1 : index;
      index++;
    }
    return null;
  }

  function versionAfterWrite(meta) {
    return meta ? meta.version + 1 : 1;
  }

  function _incrBy(key, delta) {
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

  function getKeyMeta(key) {
    const k = Buffer.isBuffer(key) ? key : asKey(key);
    const meta = keys.get(k);
    if (meta && meta.expiresAt != null && meta.expiresAt <= clock()) {
      keys.delete(k);
      invalidateCachedKey(k);
      return null;
    }
    return meta;
  }

  function readString(key, { wrongTypeAsNull = false } = {}) {
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
    get(key) {
      return readString(key);
    },

    strlen(key) {
      const v = readString(key);
      return v ? v.length : 0;
    },

    set(key, value, options = {}) {
      const k = asKey(key);
      const existingMeta = getKeyMeta(k); // lazy-expire if needed
      const v = asValue(value);
      let expiresAt = options.expiresAt ?? null;
      if (options.ex != null) expiresAt = clock() + options.ex * 1000;
      if (options.px != null) expiresAt = clock() + options.px;
      strings.set(k, v, { expiresAt, existingMeta });
      cacheString(k, v, { version: versionAfterWrite(existingMeta), expiresAt });
    },

    mset(pairs) {
      const entriesByKey = new Map();
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
            options: { existingMeta: getKeyMeta(k) },
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

    msetnx(pairs) {
      const entriesByKey = new Map();
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

    mget(keysList) {
      return keysList.map((key) => readString(key, { wrongTypeAsNull: true }));
    },

    del(keysToDelete) {
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

    exists(keysToCheck) {
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

    expire(key, seconds) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return false;
      const expiresAt = clock() + seconds * 1000;
      keys.setExpires(k, expiresAt);
      invalidateCachedKey(k);
      return true;
    },

    pexpire(key, milliseconds) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return false;
      const expiresAt = clock() + milliseconds;
      keys.setExpires(k, expiresAt);
      invalidateCachedKey(k);
      return true;
    },

    ttl(key) {
      const meta = getKeyMeta(key);
      if (!meta) return -2;
      if (meta.expiresAt == null) return -1;
      const ms = meta.expiresAt - clock();
      if (ms <= 0) return -2;
      return Math.floor(ms / 1000);
    },

    pttl(key) {
      const meta = getKeyMeta(key);
      if (!meta) return -2;
      if (meta.expiresAt == null) return -1;
      const ms = meta.expiresAt - clock();
      if (ms <= 0) return -2;
      return ms;
    },

    persist(key) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return false;
      keys.setExpires(k, null);
      invalidateCachedKey(k);
      return true;
    },

    incr(key) {
      return _incrBy(key, 1);
    },

    decr(key) {
      return _incrBy(key, -1);
    },

    incrby(key, delta) {
      return _incrBy(key, delta);
    },

    decrby(key, delta) {
      return _incrBy(key, -delta);
    },

    hset(key, ...pairs) {
      const k = asKey(key);
      const existingMeta = getKeyMeta(k);
      const keyValuePairs = pairs.map((p) => (Buffer.isBuffer(p) ? p : asValue(p)));
      if (keyValuePairs.length === 2) {
        hashes.set(k, keyValuePairs[0], keyValuePairs[1], { existingMeta });
      } else {
        hashes.setMultiple(k, keyValuePairs, { existingMeta });
      }
      invalidateCachedKey(k);
      return Math.floor(pairs.length / 2);
    },

    hget(key, field) {
      const k = asKey(key);
      const f = asKey(field);
      const cached = readCachedHash(k);
      if (cached !== CACHE_MISS) return cached ? readCachedHashField(cached, f) : null;
      const meta = getKeyMeta(k);
      if (!meta) return null;
      expectHash(meta);
      return hashes.get(k, f);
    },

    hmget(key, fields) {
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

    hgetall(key) {
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

    hkeys(key) {
      const flat = this.hgetall(key);
      const out = [];
      for (let i = 0; i < flat.length; i += 2) out.push(flat[i]);
      return out;
    },

    hvals(key) {
      const flat = this.hgetall(key);
      const out = [];
      for (let i = 1; i < flat.length; i += 2) out.push(flat[i]);
      return out;
    },

    hdel(key, fields) {
      const k = asKey(key);
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectHash(meta);
      const deleted = hashes.delete(k, fields.map((f) => asKey(f)), { existingMeta: meta });
      invalidateCachedKey(k);
      return deleted;
    },

    hlen(key) {
      const k = asKey(key);
      const cached = readCachedHash(k);
      if (cached !== CACHE_MISS) return cached ? cached.size : 0;
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectHash(meta);
      return hashes.count(k, { existingMeta: meta });
    },

    hexists(key, field) {
      const v = this.hget(key, field);
      return v != null ? 1 : 0;
    },

    hincrby(key, field, amount) {
      const k = asKey(key);
      const existingMeta = getKeyMeta(k);
      const amt = parseInt(Buffer.isBuffer(amount) ? amount.toString() : String(amount), 10);
      if (Number.isNaN(amt)) throw new Error('ERR value is not an integer or out of range');
      const next = hashes.incr(k, asKey(field), amt, { existingMeta });
      invalidateCachedKey(k);
      return next;
    },

    /**
     * HEXPIRE: apply absolute expiresAtMs to each hash field with optional NX/XX/GT/LT.
     * Returns an array of integers per spec: -2 (missing), 0 (cond), 1 (set), 2 (deleted).
     */
    hexpire(key, expiresAtMs, fields, { condition = null } = {}) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return fields.map(() => -2);
      expectHash(meta);
      try {
        return fields.map((f) => hashes.setFieldExpire(k, asKey(f), expiresAtMs, { condition }));
      } finally {
        invalidateCachedKey(k);
      }
    },

    /**
     * HTTL: seconds remaining per field. -2 missing, -1 no TTL, else seconds.
     */
    httl(key, fields) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return fields.map(() => -2);
      expectHash(meta);
      try {
        return fields.map((f) => {
          const ms = hashes.getFieldTtl(k, asKey(f));
          if (ms < 0) return ms;
          return Math.floor(ms / 1000);
        });
      } finally {
        invalidateCachedKey(k);
      }
    },

    /**
     * HPERSIST: clear field TTL. -2 missing, -1 no TTL, 1 cleared.
     */
    hpersist(key, fields) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return fields.map(() => -2);
      expectHash(meta);
      try {
        return fields.map((f) => hashes.persistField(k, asKey(f)));
      } finally {
        invalidateCachedKey(k);
      }
    },

    sadd(key, ...members) {
      const k = asKey(key);
      getKeyMeta(key);
      const buf = members.map((m) => (Buffer.isBuffer(m) ? m : asKey(m)));
      const added = sets.add(k, buf);
      invalidateCachedKey(k);
      return added;
    },

    srem(key, members) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectSet(meta);
      const removed = sets.remove(k, members.map((m) => asKey(m)));
      invalidateCachedKey(k);
      return removed;
    },

    smembers(key) {
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

    sismember(key, member) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'set');
      if (cached !== CACHE_MISS) return cached && cached.has(cacheKey(asKey(member))) ? 1 : 0;
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectSet(meta);
      return sets.has(k, asKey(member)) ? 1 : 0;
    },

    smismember(key, members) {
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

    scard(key) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'set');
      if (cached !== CACHE_MISS) return cached ? cached.size : 0;
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectSet(meta);
      return sets.count(k);
    },

    spop(key, count = null) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return count != null && count !== 1 ? [] : null;
      expectSet(meta);
      const popped = sets.popRandom(k, count);
      invalidateCachedKey(k);
      return popped;
    },

    srandmember(key, count = null) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'set');
      if (cached !== CACHE_MISS) return cached ? randomCachedSetMembers(cached, count) : null;
      const meta = getKeyMeta(k);
      if (!meta) return count != null && count !== 1 ? [] : null;
      expectSet(meta);
      return sets.getRandomMembers(k, count);
    },

    lpush(key, ...values) {
      const k = asKey(key);
      getKeyMeta(key);
      const buf = values.map((v) => (Buffer.isBuffer(v) ? v : asValue(v)));
      const n = lists.lpush(k, buf);
      invalidateCachedKey(k);
      if (this._blockingManager) this._blockingManager.wakeup(k);
      return n;
    },

    rpush(key, ...values) {
      const k = asKey(key);
      getKeyMeta(key);
      const buf = values.map((v) => (Buffer.isBuffer(v) ? v : asValue(v)));
      const n = lists.rpush(k, buf);
      invalidateCachedKey(k);
      if (this._blockingManager) this._blockingManager.wakeup(k);
      return n;
    },

    llen(key) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'list');
      if (cached !== CACHE_MISS) return cached ? cached.length : 0;
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectList(meta);
      return lists.llen(k);
    },

    lrange(key, start, stop) {
      const k = asKey(key);
      const s = parseInt(String(start), 10);
      const e = parseInt(String(stop), 10);
      if (Number.isNaN(s) || Number.isNaN(e)) return [];
      const cached = readCachedCollection(k, 'list');
      if (cached !== CACHE_MISS) return cached ? cachedListRange(cached, s, e) : [];
      const meta = getKeyMeta(k);
      if (!meta) return [];
      expectList(meta);
      const values = lists.lrange(k, s, e);
      if (s === 0 && e === -1) cacheList(k, values, meta);
      return values;
    },

    lindex(key, index) {
      const k = asKey(key);
      const i = parseInt(String(index), 10);
      if (Number.isNaN(i)) return null;
      const cached = readCachedCollection(k, 'list');
      if (cached !== CACHE_MISS) return cached ? cachedListIndex(cached, i) : null;
      const meta = getKeyMeta(k);
      if (!meta) return null;
      expectList(meta);
      return lists.lindex(k, i);
    },

    lpop(key, count = null) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return count != null && count > 0 ? [] : null;
      expectList(meta);
      const popped = lists.lpop(k, count);
      invalidateCachedKey(k);
      return popped;
    },

    rpop(key, count = null) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return count != null && count > 0 ? [] : null;
      expectList(meta);
      const popped = lists.rpop(k, count);
      invalidateCachedKey(k);
      return popped;
    },

    lmpop(keysToCheck, direction, count) {
      return runInTransaction(db, () => {
        for (const key of keysToCheck) {
          const k = asKey(key);
          const meta = getKeyMeta(k);
          if (!meta) continue;
          expectList(meta);
          const values = direction === 'LEFT'
            ? lists.lpop(k, count)
            : lists.rpop(k, count);
          invalidateCachedKey(k);
          if (values.length > 0) return [k, values];
        }
        return null;
      });
    },

    lrem(key, count, element) {
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

    lset(key, index, value) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) throw new Error('ERR no such key');
      expectList(meta);
      const i = parseInt(Buffer.isBuffer(index) ? index.toString() : String(index), 10);
      if (Number.isNaN(i)) throw new Error('ERR index out of range');
      const val = Buffer.isBuffer(value) ? value : asValue(value);
      lists.lset(k, i, val);
      invalidateCachedKey(k);
    },

    ltrim(key, start, stop) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return;
      expectList(meta);
      const s = parseInt(Buffer.isBuffer(start) ? start.toString() : String(start), 10);
      const e = parseInt(Buffer.isBuffer(stop) ? stop.toString() : String(stop), 10);
      if (Number.isNaN(s) || Number.isNaN(e)) return;
      lists.ltrim(k, s, e);
      invalidateCachedKey(k);
    },

    zadd(key, scoreMemberPairs) {
      const k = asKey(key);
      getKeyMeta(key);
      const pairs = [];
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

    zrem(key, members) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectZset(meta);
      const removed = zsets.remove(k, members.map((m) => asKey(m)));
      invalidateCachedKey(k);
      return removed;
    },

    zcard(key) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) return cached ? cached.size : 0;
      const meta = getKeyMeta(k);
      if (!meta) return 0;
      expectZset(meta);
      return zsets.count(k);
    },

    zscore(key, member) {
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

    zmscore(key, members) {
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

    zmpop(keysToCheck, direction, count) {
      return runInTransaction(db, () => {
        for (const key of keysToCheck) {
          const k = asKey(key);
          const meta = getKeyMeta(k);
          if (!meta) continue;
          expectZset(meta);
          const flat = direction === 'MIN'
            ? zsets.rangeByRank(k, 0, count - 1, { withScores: true })
            : zsets.rangeByRankReverse(k, 0, count - 1, { withScores: true });
          if (flat.length === 0) continue;
          const members = [];
          const entries = [];
          for (let i = 0; i < flat.length; i += 2) {
            members.push(flat[i]);
            entries.push([flat[i], flat[i + 1]]);
          }
          zsets.remove(k, members);
          invalidateCachedKey(k);
          return [k, entries];
        }
        return null;
      });
    },

    zrange(key, start, stop, options = {}) {
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

    zrevrange(key, start, stop, options = {}) {
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
        const entries = [];
        for (let i = 0; i < flat.length; i += 2) {
          entries.push([flat[i], String(flat[i + 1]), Number(flat[i + 1])]);
        }
        entries.reverse();
        return formatCachedZset(entries, options.withScores);
      }
      return zsets.rangeByRankReverse(k, start, stop, { withScores: options.withScores });
    },

    zrevrank(key, member) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) return cached ? cachedZsetRank(cached, asKey(member), true) : null;
      const meta = getKeyMeta(k);
      if (!meta) return null;
      expectZset(meta);
      return zsets.rankReverse(k, asKey(member));
    },

    zrank(key, member) {
      const k = asKey(key);
      const cached = readCachedCollection(k, 'zset');
      if (cached !== CACHE_MISS) return cached ? cachedZsetRank(cached, asKey(member)) : null;
      const meta = getKeyMeta(k);
      if (!meta) return null;
      expectZset(meta);
      return zsets.rank(k, asKey(member));
    },

    zrangebyscore(key, min, max, options = {}) {
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

    zcount(key, min, max) {
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

    zincrby(key, increment, member) {
      const k = asKey(key);
      getKeyMeta(key);
      const inc = parseFloat(Buffer.isBuffer(increment) ? increment.toString() : String(increment));
      if (Number.isNaN(inc)) throw new Error('ERR value is not a valid float');
      const score = zsets.incr(k, asKey(member), inc);
      invalidateCachedKey(k);
      return score;
    },

    zremrangebyrank(key, start, stop) {
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

    zremrangebyscore(key, min, max) {
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

    zrevrangebyscore(key, max, min, options = {}) {
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

    type(key) {
      const meta = getKeyMeta(key);
      return typeName(meta);
    },

    /**
     * OBJECT IDLETIME: seconds since key was last written (updated_at).
     * Returns null if key does not exist (Redis: nil).
     */
    objectIdletime(key) {
      const meta = getKeyMeta(key);
      if (!meta || meta.updatedAt == null) return null;
      const elapsedMs = clock() - meta.updatedAt;
      return Math.floor(elapsedMs / 1000);
    },

    scan(cursor, options = {}) {
      const count = options.count ?? 10;
      const offset = parseInt(String(cursor), 10) || 0;
      const keysList = keys.scan(count, offset);
      const nextCursor = keysList.length < count ? 0 : offset + keysList.length;
      return { cursor: nextCursor, keys: keysList };
    },

    rename(key, newkey) {
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
    _blockingManager: null,
  };
  engine._blockingManager = createBlockingManager(engine, { clock });
  return engine;
}

export { KEY_TYPES };
