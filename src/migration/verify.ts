/**
 * Verification: sample keys and compare Redis vs RespLite destination (SPEC_F §F.9 Step 7).
 */

import { openDb } from '../storage/sqlite/db.ts';
import { createKeysStorage } from '../storage/sqlite/keys.ts';
import { createStringsStorage } from '../storage/sqlite/strings.ts';
import { createHashesStorage } from '../storage/sqlite/hashes.ts';
import { createSetsStorage } from '../storage/sqlite/sets.ts';
import { createListsStorage } from '../storage/sqlite/lists.ts';
import { createZsetsStorage } from '../storage/sqlite/zsets.ts';
import { KEY_TYPES } from '../storage/sqlite/schema.ts';
import { asKey } from '../util/buffers.ts';
import type { ImportStorages } from './import-one.ts';
import type { MigrationRedisClient } from './redis-client.ts';

export interface VerifyOptions {
  /** PRAGMA preset. Default `'default'`. */
  pragmaTemplate?: string;
  /** Sample percentage (0.5 = 0.5%). Default 0.5. */
  samplePct?: number;
  /** Default 10000. */
  maxSample?: number;
}

export interface VerifyMismatch {
  key: string;
  reason: string;
}

export interface VerifyResult {
  sampled: number;
  matched: number;
  mismatches: VerifyMismatch[];
}

interface ZsetEntry {
  member: string;
  score: number;
}

/**
 * Get key type and value from destination DB for comparison.
 */
function getKeyFromDestination(
  storages: ImportStorages,
  keyBuf: Buffer
): { type: string; value?: unknown; ttl?: number } | null {
  const { keys, strings, hashes, sets, lists, zsets } = storages;
  const meta = keys.get(keyBuf);
  if (!meta) return null;

  const typeNum = meta.type;
  let type = 'unknown';
  if (typeNum === KEY_TYPES.STRING) type = 'string';
  else if (typeNum === KEY_TYPES.HASH) type = 'hash';
  else if (typeNum === KEY_TYPES.SET) type = 'set';
  else if (typeNum === KEY_TYPES.LIST) type = 'list';
  else if (typeNum === KEY_TYPES.ZSET) type = 'zset';

  let value: string | null | Record<string, string> | string[] | ZsetEntry[] | undefined;
  if (typeNum === KEY_TYPES.STRING) {
    const v = strings.get(keyBuf);
    value = v ? v.toString('utf8') : null;
  } else if (typeNum === KEY_TYPES.HASH) {
    const flat = hashes.getAll(keyBuf);
    const obj: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) {
      obj[flat[i].toString('utf8')] = flat[i + 1].toString('utf8');
    }
    value = obj;
  } else if (typeNum === KEY_TYPES.SET) {
    value = sets.members(keyBuf).map((b) => b.toString('utf8')).sort();
  } else if (typeNum === KEY_TYPES.LIST) {
    value = lists.lrange(keyBuf, 0, -1).map((b) => b.toString('utf8'));
  } else if (typeNum === KEY_TYPES.ZSET) {
    const flat = zsets.rangeByRank(keyBuf, 0, -1, { withScores: true });
    value = [] as ZsetEntry[];
    for (let i = 0; i < flat.length; i += 2) {
      value.push({ member: flat[i].toString('utf8'), score: Number(flat[i + 1]) });
    }
  }

  const now = Date.now();
  const expiresAt = meta.expiresAt;
  const ttl = expiresAt != null && expiresAt > now
    ? (typeof expiresAt === 'bigint' ? Number((expiresAt - BigInt(now)) / 1000n) : Math.floor((expiresAt - now) / 1000))
    : -1;

  return { type, value, ttl };
}

/**
 * Run verification: sample keys from Redis, compare with destination DB.
 */
export async function runVerify(
  redisClient: MigrationRedisClient,
  dbPath: string,
  options: VerifyOptions = {}
): Promise<VerifyResult> {
  const { pragmaTemplate = 'default', samplePct = 0.5, maxSample = 10000 } = options;

  const db = openDb(dbPath, { pragmaTemplate });
  const keys = createKeysStorage(db);
  const strings = createStringsStorage(db, keys);
  const hashes = createHashesStorage(db, keys);
  const sets = createSetsStorage(db, keys);
  const lists = createListsStorage(db, keys);
  const zsets = createZsetsStorage(db, keys);
  const storages = { keys, strings, hashes, sets, lists, zsets };

  const keyList: string[] = [];
  let cursor = 0;
  const takeEvery = Math.max(1, Math.floor(100 / samplePct));
  let index = 0;

  do {
    const result = await redisClient.scan(cursor, { COUNT: 500 });
    const keysBatch = Array.isArray(result) ? result[1] : (result?.keys || []);
    cursor = Array.isArray(result) ? parseInt(result[0], 10) : (result?.cursor ?? 0);
    for (const k of keysBatch) {
      if (index++ % takeEvery === 0) keyList.push(k);
      if (keyList.length >= maxSample) break;
    }
    if (keyList.length >= maxSample) break;
  } while (cursor !== 0);

  let matched = 0;
  const mismatches: VerifyMismatch[] = [];

  for (const keyName of keyList) {
    const keyBuf = asKey(keyName);
    const dest = getKeyFromDestination(storages, keyBuf);
    try {
      const redisType = (await redisClient.type(keyName)).toLowerCase();
      let redisTtl = await redisClient.pTTL(keyName);
      if (redisTtl === -2) redisTtl = -1;
      else if (redisTtl > 0) redisTtl = Math.floor(redisTtl / 1000);

      if (!dest) {
        mismatches.push({ key: keyName, reason: 'missing in destination' });
        continue;
      }
      if (dest.type !== redisType) {
        mismatches.push({ key: keyName, reason: `type mismatch: Redis=${redisType} dest=${dest.type}` });
        continue;
      }
      if (dest.ttl !== undefined && redisTtl >= 0 && dest.ttl !== redisTtl) {
        if (Math.abs(dest.ttl - redisTtl) > 1) {
          mismatches.push({ key: keyName, reason: `TTL mismatch: Redis=${redisTtl}s dest=${dest.ttl}s` });
          continue;
        }
      }

      if (redisType === 'string') {
        const redisVal = await redisClient.get(keyName);
        const destVal = dest.value;
        if (String(redisVal ?? '') !== String(destVal ?? '')) {
          mismatches.push({ key: keyName, reason: 'value mismatch (string)' });
          continue;
        }
      } else if (redisType === 'hash') {
        const redisObj = await redisClient.hGetAll(keyName);
        const destObj = (dest.value || {}) as Record<string, string>;
        const redisKeys = Object.keys(redisObj || {}).sort();
        const destKeys = Object.keys(destObj).sort();
        if (redisKeys.join(',') !== destKeys.join(',')) {
          mismatches.push({ key: keyName, reason: 'hash field mismatch' });
          continue;
        }
        for (const f of redisKeys) {
          if (String((redisObj || {})[f]) !== String(destObj[f])) {
            mismatches.push({ key: keyName, reason: `hash field '${f}' value mismatch` });
            break;
          }
        }
        if (mismatches[mismatches.length - 1]?.key === keyName) continue;
      } else if (redisType === 'set') {
        const redisMembers = (await redisClient.sMembers(keyName)).sort();
        const destMembers = ((dest.value || []) as string[]).slice().sort();
        if (redisMembers.length !== destMembers.length || redisMembers.join(',') !== destMembers.join(',')) {
          mismatches.push({ key: keyName, reason: 'set members mismatch' });
          continue;
        }
      } else if (redisType === 'list') {
        const redisList = await redisClient.lRange(keyName, 0, -1);
        const destList = (dest.value || []) as string[];
        if (redisList.length !== destList.length || redisList.join(',') !== destList.join(',')) {
          mismatches.push({ key: keyName, reason: 'list elements mismatch' });
          continue;
        }
      } else if (redisType === 'zset') {
        const redisZ = await redisClient.zRangeWithScores(keyName, 0, -1);
        const destZ = (dest.value || []) as ZsetEntry[];
        if (redisZ.length !== destZ.length) {
          mismatches.push({ key: keyName, reason: 'zset cardinality mismatch' });
          continue;
        }
        for (let i = 0; i < redisZ.length; i++) {
          const r = redisZ[i];
          const d = destZ[i];
          if (r.value !== d.member || Number(r.score) !== Number(d.score)) {
            mismatches.push({ key: keyName, reason: 'zset member/score mismatch' });
            break;
          }
        }
        if (mismatches[mismatches.length - 1]?.key === keyName) continue;
      }

      matched++;
    } catch (err) {
      mismatches.push({ key: keyName, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { sampled: keyList.length, matched, mismatches };
}
