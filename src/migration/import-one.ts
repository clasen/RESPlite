/**
 * Import a single key from Redis into RespLite storages (shared by bulk and delta apply).
 * SPEC_F §F.7.1, F.8.2.
 */

import { asKey, asValue } from '../util/buffers.ts';
import type { createKeysStorage } from '../storage/sqlite/keys.ts';
import type { createStringsStorage } from '../storage/sqlite/strings.ts';
import type { createHashesStorage } from '../storage/sqlite/hashes.ts';
import type { createSetsStorage } from '../storage/sqlite/sets.ts';
import type { createListsStorage } from '../storage/sqlite/lists.ts';
import type { createZsetsStorage } from '../storage/sqlite/zsets.ts';
import type { MigrationRedisClient } from './redis-client.ts';

/** Destination storages a key is written to. */
export interface ImportStorages {
  keys: ReturnType<typeof createKeysStorage>;
  strings: ReturnType<typeof createStringsStorage>;
  hashes: ReturnType<typeof createHashesStorage>;
  sets: ReturnType<typeof createSetsStorage>;
  lists: ReturnType<typeof createListsStorage>;
  zsets: ReturnType<typeof createZsetsStorage>;
}

export interface ImportKeyOptions {
  now?: number;
  zsetScanCount?: number;
}

export interface ImportKeyResult {
  ok: boolean;
  skipped?: boolean;
  error?: boolean;
  bytes?: number;
}

const SUPPORTED_TYPES = new Set(['string', 'hash', 'set', 'list', 'zset']);

function toBuffer(value: NonNullable<unknown>): Buffer;
function toBuffer(value: unknown): Buffer | null;
function toBuffer(value: unknown): Buffer | null {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(String(value), 'utf8');
}

function parseZscanResult(raw: unknown): { cursor: number; entries: Array<{ value: NonNullable<unknown>; score: number }> } {
  if (!Array.isArray(raw) || raw.length < 2) {
    return { cursor: 0, entries: [] };
  }
  const cursor = parseInt(String(raw[0] ?? '0'), 10) || 0;
  const flat = Array.isArray(raw[1]) ? raw[1] : [];
  const entries: Array<{ value: NonNullable<unknown>; score: number }> = [];
  for (let i = 0; i < flat.length; i += 2) {
    const member = flat[i];
    const score = flat[i + 1];
    if (member == null || score == null) continue;
    entries.push({ value: member, score: Number(score) });
  }
  return { cursor, entries };
}

/**
 * Fetch one key from Redis and write to storages. Idempotent (upsert).
 */
export async function importKeyFromRedis(
  redisClient: MigrationRedisClient,
  keyName: string,
  storages: ImportStorages,
  options: ImportKeyOptions = {}
): Promise<ImportKeyResult> {
  const now = options.now ?? Date.now();
  const zsetScanCount = Number.isFinite(options.zsetScanCount)
    ? Math.max(10, Math.floor(options.zsetScanCount as number))
    : 1000;
  const { keys, strings, hashes, sets, lists, zsets } = storages;

  try {
    const type = (await redisClient.type(keyName)).toLowerCase();
    if (!SUPPORTED_TYPES.has(type)) {
      return { ok: false, skipped: true };
    }

    let pttl = await redisClient.pTTL(keyName);
    if (pttl === -2) pttl = -1;
    const expiresAt = pttl > 0 ? now + pttl : null;
    const keyBuf = asKey(keyName);

    let bytes = keyBuf.length;

    if (type === 'string') {
      const value = await redisClient.get(keyName);
      if (value === undefined || value === null) return { ok: false, skipped: true };
      const valBuf = asValue(value);
      bytes += valBuf.length;
      strings.set(keyBuf, valBuf, { expiresAt, updatedAt: now });
      return { ok: true, bytes };
    }

    if (type === 'hash') {
      const obj = await redisClient.hGetAll(keyName);
      if (!obj || typeof obj !== 'object') return { ok: false, skipped: true };
      const pairs: Buffer[] = [];
      for (const [f, v] of Object.entries(obj)) {
        const fb = toBuffer(f);
        const vb = toBuffer(v);
        pairs.push(fb, vb);
        bytes += fb.length + vb.length;
      }
      if (pairs.length === 0) return { ok: false, skipped: true };
      hashes.setMultiple(keyBuf, pairs, { updatedAt: now });
      keys.setExpires(keyBuf, expiresAt, now);
      return { ok: true, bytes };
    }

    if (type === 'set') {
      const members = await redisClient.sMembers(keyName);
      if (!members || !members.length) return { ok: false, skipped: true };
      const memberBuffers = members.map((m) => toBuffer(m));
      for (const b of memberBuffers) bytes += b.length;
      sets.add(keyBuf, memberBuffers, { updatedAt: now });
      keys.setExpires(keyBuf, expiresAt, now);
      return { ok: true, bytes };
    }

    if (type === 'list') {
      const elements = await redisClient.lRange(keyName, 0, -1);
      if (!elements || !elements.length) return { ok: false, skipped: true };
      const valueBuffers = elements.map((e) => toBuffer(e));
      for (const b of valueBuffers) bytes += b.length;
      lists.rpush(keyBuf, valueBuffers, { updatedAt: now });
      keys.setExpires(keyBuf, expiresAt, now);
      return { ok: true, bytes };
    }

    if (type === 'zset') {
      try {
        // Use cursor-based reads to avoid loading very large sorted sets in one call.
        let cursor = 0;
        let wroteAny = false;
        do {
          const raw = await redisClient.sendCommand([
            'ZSCAN',
            keyName,
            String(cursor),
            'COUNT',
            String(zsetScanCount),
          ]);
          const parsed = parseZscanResult(raw);
          cursor = parsed.cursor;
          if (parsed.entries.length === 0) continue;
          const pairs = parsed.entries.map((item) => ({
            member: toBuffer(item.value),
            score: Number(item.score),
          }));
          for (const p of pairs) bytes += p.member.length + 8;
          zsets.add(keyBuf, pairs, { updatedAt: now });
          wroteAny = true;
        } while (cursor !== 0);

        if (!wroteAny) return { ok: false, skipped: true };
        keys.setExpires(keyBuf, expiresAt, now);
        return { ok: true, bytes };
      } catch {
        // Fallback for clients/backends without command passthrough support.
        const withScores = await redisClient.zRangeWithScores(keyName, 0, -1);
        if (!withScores || !withScores.length) return { ok: false, skipped: true };
        const pairs = withScores.map((item) => ({
          member: toBuffer(item.value),
          score: Number(item.score),
        }));
        for (const p of pairs) bytes += p.member.length + 8;
        zsets.add(keyBuf, pairs, { updatedAt: now });
        keys.setExpires(keyBuf, expiresAt, now);
        return { ok: true, bytes };
      }
    }

    return { ok: false, skipped: true };
  } catch (err) {
    return { ok: false, error: true };
  }
}

export { SUPPORTED_TYPES };
