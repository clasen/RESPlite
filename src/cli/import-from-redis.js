/**
 * Import data from Redis into RESPlite SQLite DB (SPEC §26).
 * External CLI: connect to Redis, SCAN keys, TYPE, fetch by type, PTTL, write to SQLite.
 * Usage: node src/cli/import-from-redis.js --redis-url redis://127.0.0.1:6379 --db ./data.db
 */

import { createClient } from 'redis';
import { fileURLToPath } from 'node:url';
import { openDb } from '../storage/sqlite/db.js';
import { createKeysStorage } from '../storage/sqlite/keys.js';
import { createStringsStorage } from '../storage/sqlite/strings.js';
import { createHashesStorage } from '../storage/sqlite/hashes.js';
import { createSetsStorage } from '../storage/sqlite/sets.js';
import { createListsStorage } from '../storage/sqlite/lists.js';
import { createZsetsStorage } from '../storage/sqlite/zsets.js';
import { asKey, asValue } from '../util/buffers.js';

const SUPPORTED_TYPES = new Set(['string', 'hash', 'set', 'list', 'zset']);

function parseArgs() {
  const args = process.argv.slice(2);
  let redisUrl = null;
  let host = '127.0.0.1';
  let port = 6379;
  let dbPath = null;
  let pragmaTemplate = 'default';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--redis-url' && args[i + 1]) {
      redisUrl = args[++i];
    } else if (args[i] === '--host' && args[i + 1]) {
      host = args[++i];
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === '--db' && args[i + 1]) {
      dbPath = args[++i];
    } else if (args[i] === '--pragma-template' && args[i + 1]) {
      pragmaTemplate = args[++i];
    }
  }

  if (!dbPath) {
    console.error('Usage: node import-from-redis.js --db <path> [--redis-url <url> | --host <host> --port <port>] [--pragma-template <name>]');
    process.exit(1);
  }

  return {
    redisUrl: redisUrl || `redis://${host}:${port}`,
    dbPath,
    pragmaTemplate,
  };
}

function toBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(String(value), 'utf8');
}

/**
 * Normalize scan result: node-redis can return { cursor, keys } or [cursor, keys].
 */
function parseScanResult(result) {
  if (Array.isArray(result)) {
    return { cursor: parseInt(result[0], 10), keys: result[1] || [] };
  }
  if (result && typeof result === 'object') {
    const cursor = typeof result.cursor === 'number' ? result.cursor : parseInt(String(result.cursor), 10);
    const keys = result.keys || [];
    return { cursor, keys };
  }
  return { cursor: 0, keys: [] };
}

async function importFromRedis(redisClient, dbPath, options = {}) {
  const { pragmaTemplate = 'default' } = options;
  const db = openDb(dbPath, { pragmaTemplate });
  const keys = createKeysStorage(db);
  const strings = createStringsStorage(db, keys);
  const hashes = createHashesStorage(db, keys);
  const sets = createSetsStorage(db, keys);
  const lists = createListsStorage(db, keys);
  const zsets = createZsetsStorage(db, keys);

  const now = Date.now();
  const stats = { string: 0, hash: 0, set: 0, list: 0, zset: 0, skipped: 0, errors: 0 };

  let cursor = 0;
  do {
    const result = await redisClient.scan(cursor);
    const parsed = parseScanResult(result);
    cursor = parsed.cursor;
    const keyList = parsed.keys || [];

    for (const keyName of keyList) {
      try {
        const type = (await redisClient.type(keyName)).toLowerCase();
        if (!SUPPORTED_TYPES.has(type)) {
          stats.skipped++;
          continue;
        }

        let pttl = await redisClient.pTTL(keyName);
        if (pttl === -2) pttl = -1;
        const expiresAt = pttl > 0 ? now + pttl : null;
        const keyBuf = asKey(keyName);

        if (type === 'string') {
          const value = await redisClient.get(keyName);
          if (value !== undefined && value !== null) {
            strings.set(keyBuf, asValue(value), { expiresAt, updatedAt: now });
            stats.string++;
          }
        } else if (type === 'hash') {
          const obj = await redisClient.hGetAll(keyName);
          if (obj && typeof obj === 'object') {
            const pairs = [];
            for (const [f, v] of Object.entries(obj)) {
              pairs.push(toBuffer(f), toBuffer(v));
            }
            if (pairs.length) {
              hashes.setMultiple(keyBuf, pairs, { updatedAt: now });
              keys.setExpires(keyBuf, expiresAt, now);
              stats.hash++;
            }
          }
        } else if (type === 'set') {
          const members = await redisClient.sMembers(keyName);
          if (members && members.length) {
            const memberBuffers = members.map((m) => toBuffer(m));
            sets.add(keyBuf, memberBuffers, { updatedAt: now });
            keys.setExpires(keyBuf, expiresAt, now);
            stats.set++;
          }
        } else if (type === 'list') {
          const elements = await redisClient.lRange(keyName, 0, -1);
          if (elements && elements.length) {
            const valueBuffers = elements.map((e) => toBuffer(e));
            lists.rpush(keyBuf, valueBuffers, { updatedAt: now });
            keys.setExpires(keyBuf, expiresAt, now);
            stats.list++;
          }
        } else if (type === 'zset') {
          const withScores = await redisClient.zRangeWithScores(keyName, 0, -1);
          if (withScores && withScores.length) {
            const pairs = withScores.map((item) => ({
              member: toBuffer(item.value),
              score: Number(item.score),
            }));
            zsets.add(keyBuf, pairs, { updatedAt: now });
            keys.setExpires(keyBuf, expiresAt, now);
            stats.zset++;
          }
        }
      } catch (err) {
        stats.errors++;
        console.error(`Error importing key "${keyName}":`, err.message);
      }
    }
  } while (cursor !== 0);

  return { db, stats };
}

async function main() {
  const { redisUrl, dbPath, pragmaTemplate } = parseArgs();

  const client = createClient({ url: redisUrl });
  client.on('error', (err) => console.error('Redis client error:', err.message));

  await client.connect();

  try {
    console.log(`Importing from ${redisUrl} into ${dbPath} ...`);
    const { stats } = await importFromRedis(client, dbPath, { pragmaTemplate });
    console.log('Import complete.');
    console.log(`  strings: ${stats.string}, hashes: ${stats.hash}, sets: ${stats.set}, lists: ${stats.list}, zsets: ${stats.zset}`);
    if (stats.skipped) console.log(`  skipped (unsupported type): ${stats.skipped}`);
    if (stats.errors) console.log(`  errors: ${stats.errors}`);
  } finally {
    await client.quit();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { importFromRedis, parseScanResult, parseArgs };
