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
import { createBlockingManager } from '../blocking/manager.js';
import { runInTransaction } from '../storage/sqlite/tx.js';
import { expectString, expectHash, expectSet, expectList, expectZset, typeName } from './validate.js';
import { asKey, asValue } from '../util/buffers.js';

export function createEngine(opts = {}) {
  const { db, cache } = opts;
  const keys = createKeysStorage(db);
  const strings = createStringsStorage(db, keys);
  const hashes = createHashesStorage(db, keys);
  const sets = createSetsStorage(db, keys);
  const lists = createListsStorage(db, keys);
  const zsets = createZsetsStorage(db, keys);

  const clock = opts.clock ?? (() => Date.now());

  function _incrBy(key, delta) {
    const k = asKey(key);
    const meta = getKeyMeta(key);
    if (meta) expectString(meta);
    const cur = strings.get(k);
    const num = cur == null ? 0 : parseInt(cur.toString('utf8'), 10);
    if (Number.isNaN(num)) throw new Error('ERR value is not an integer or out of range');
    const next = num + delta;
    strings.set(k, Buffer.from(String(next), 'utf8'));
    return next;
  }

  function getKeyMeta(key) {
    const k = Buffer.isBuffer(key) ? key : asKey(key);
    const meta = keys.get(k);
    if (meta && meta.expiresAt != null && meta.expiresAt <= clock()) {
      keys.delete(k);
      return null;
    }
    return meta;
  }

  const engine = {
    get(key) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return null;
      expectString(meta);
      return strings.get(k);
    },

    strlen(key) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectString(meta);
      const v = strings.get(k);
      return v ? v.length : 0;
    },

    set(key, value, options = {}) {
      const k = asKey(key);
      getKeyMeta(key); // lazy-expire if needed
      const v = asValue(value);
      let expiresAt = options.expiresAt ?? null;
      if (options.ex != null) expiresAt = clock() + options.ex * 1000;
      if (options.px != null) expiresAt = clock() + options.px;
      strings.set(k, v, { expiresAt });
    },

    mset(pairs) {
      const entries = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const k = asKey(pairs[i]);
        getKeyMeta(pairs[i]);
        entries.push({ key: k, value: asValue(pairs[i + 1]) });
      }
      strings.setMultiple(entries);
    },

    mget(keysList) {
      return keysList.map((key) => {
        const k = asKey(key);
        const meta = getKeyMeta(key);
        if (!meta) return null;
        if (meta.type !== KEY_TYPES.STRING) return null;
        return strings.get(k);
      });
    },

    del(keysToDelete) {
      let n = 0;
      for (const key of keysToDelete) {
        const k = asKey(key);
        if (keys.get(k)) {
          keys.delete(k);
          n++;
        }
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

    expire(key, seconds) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return false;
      const expiresAt = clock() + seconds * 1000;
      keys.setExpires(k, expiresAt);
      return true;
    },

    pexpire(key, milliseconds) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return false;
      const expiresAt = clock() + milliseconds;
      keys.setExpires(k, expiresAt);
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
      getKeyMeta(key);
      const keyValuePairs = pairs.map((p) => (Buffer.isBuffer(p) ? p : asValue(p)));
      if (keyValuePairs.length === 2) {
        hashes.set(k, keyValuePairs[0], keyValuePairs[1]);
      } else {
        hashes.setMultiple(k, keyValuePairs);
      }
      return Math.floor(pairs.length / 2);
    },

    hget(key, field) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return null;
      expectHash(meta);
      return hashes.get(k, asKey(field));
    },

    hmget(key, fields) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return fields.map(() => null);
      expectHash(meta);
      return fields.map((f) => hashes.get(k, asKey(f)));
    },

    hgetall(key) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return [];
      expectHash(meta);
      return hashes.getAll(k);
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
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectHash(meta);
      return hashes.delete(k, fields.map((f) => asKey(f)));
    },

    hlen(key) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectHash(meta);
      return hashes.count(k);
    },

    hexists(key, field) {
      const v = this.hget(key, field);
      return v != null ? 1 : 0;
    },

    hincrby(key, field, amount) {
      const k = asKey(key);
      getKeyMeta(key);
      const amt = parseInt(Buffer.isBuffer(amount) ? amount.toString() : String(amount), 10);
      if (Number.isNaN(amt)) throw new Error('ERR value is not an integer or out of range');
      return hashes.incr(k, asKey(field), amt);
    },

    sadd(key, ...members) {
      const k = asKey(key);
      getKeyMeta(key);
      const buf = members.map((m) => (Buffer.isBuffer(m) ? m : asKey(m)));
      return sets.add(k, buf);
    },

    srem(key, members) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectSet(meta);
      return sets.remove(k, members.map((m) => asKey(m)));
    },

    smembers(key) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return [];
      expectSet(meta);
      return sets.members(k);
    },

    sismember(key, member) {
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectSet(meta);
      return sets.has(asKey(key), asKey(member)) ? 1 : 0;
    },

    scard(key) {
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectSet(meta);
      return sets.count(asKey(key));
    },

    spop(key, count = null) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return count != null && count !== 1 ? [] : null;
      expectSet(meta);
      return sets.popRandom(k, count);
    },

    srandmember(key, count = null) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return count != null && count !== 1 ? [] : null;
      expectSet(meta);
      return sets.getRandomMembers(k, count);
    },

    lpush(key, ...values) {
      const k = asKey(key);
      getKeyMeta(key);
      const buf = values.map((v) => (Buffer.isBuffer(v) ? v : asValue(v)));
      const n = lists.lpush(k, buf);
      if (this._blockingManager) this._blockingManager.wakeup(k);
      return n;
    },

    rpush(key, ...values) {
      const k = asKey(key);
      getKeyMeta(key);
      const buf = values.map((v) => (Buffer.isBuffer(v) ? v : asValue(v)));
      const n = lists.rpush(k, buf);
      if (this._blockingManager) this._blockingManager.wakeup(k);
      return n;
    },

    llen(key) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectList(meta);
      return lists.llen(k);
    },

    lrange(key, start, stop) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return [];
      expectList(meta);
      const s = parseInt(String(start), 10);
      const e = parseInt(String(stop), 10);
      if (Number.isNaN(s) || Number.isNaN(e)) return [];
      return lists.lrange(k, s, e);
    },

    lindex(key, index) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return null;
      expectList(meta);
      const i = parseInt(String(index), 10);
      if (Number.isNaN(i)) return null;
      return lists.lindex(k, i);
    },

    lpop(key, count = null) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return count != null && count > 0 ? [] : null;
      expectList(meta);
      return lists.lpop(k, count);
    },

    rpop(key, count = null) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return count != null && count > 0 ? [] : null;
      expectList(meta);
      return lists.rpop(k, count);
    },

    lrem(key, count, element) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectList(meta);
      const c = parseInt(Buffer.isBuffer(count) ? count.toString() : String(count), 10);
      if (Number.isNaN(c)) throw new Error('ERR value is not an integer or out of range');
      const elem = Buffer.isBuffer(element) ? element : asValue(element);
      return lists.lrem(k, c, elem);
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
      return zsets.add(k, pairs);
    },

    zrem(key, members) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectZset(meta);
      return zsets.remove(k, members.map((m) => asKey(m)));
    },

    zcard(key) {
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectZset(meta);
      return zsets.count(asKey(key));
    },

    zscore(key, member) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return null;
      expectZset(meta);
      return zsets.score(k, asKey(member));
    },

    zrange(key, start, stop, options = {}) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return [];
      expectZset(meta);
      return zsets.rangeByRank(k, start, stop, { withScores: options.withScores });
    },

    zrevrange(key, start, stop, options = {}) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return [];
      expectZset(meta);
      return zsets.rangeByRankReverse(k, start, stop, { withScores: options.withScores });
    },

    zrevrank(key, member) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return null;
      expectZset(meta);
      return zsets.rankReverse(k, asKey(member));
    },

    zrank(key, member) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return null;
      expectZset(meta);
      return zsets.rank(k, asKey(member));
    },

    zrangebyscore(key, min, max, options = {}) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
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
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectZset(meta);
      return zsets.countByScore(k, min, max);
    },

    zincrby(key, increment, member) {
      const k = asKey(key);
      getKeyMeta(key);
      const inc = parseFloat(Buffer.isBuffer(increment) ? increment.toString() : String(increment));
      if (Number.isNaN(inc)) throw new Error('ERR value is not a valid float');
      return zsets.incr(k, asKey(member), inc);
    },

    zremrangebyrank(key, start, stop) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectZset(meta);
      const s = parseInt(Buffer.isBuffer(start) ? start.toString() : String(start), 10);
      const e = parseInt(Buffer.isBuffer(stop) ? stop.toString() : String(stop), 10);
      if (Number.isNaN(s) || Number.isNaN(e)) return 0;
      return zsets.removeRangeByRank(k, s, e);
    },

    zremrangebyscore(key, min, max) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
      if (!meta) return 0;
      expectZset(meta);
      const minNum = parseFloat(Buffer.isBuffer(min) ? min.toString() : String(min));
      const maxNum = parseFloat(Buffer.isBuffer(max) ? max.toString() : String(max));
      if (Number.isNaN(minNum) || Number.isNaN(maxNum)) throw new Error('ERR value is not a valid float');
      return zsets.removeRangeByScore(k, minNum, maxNum);
    },

    zrevrangebyscore(key, max, min, options = {}) {
      const k = asKey(key);
      const meta = getKeyMeta(key);
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
