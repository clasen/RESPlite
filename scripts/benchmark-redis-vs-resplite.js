#!/usr/bin/env node
/**
 * Comparative benchmark: Redis (local) vs RESPlite (all or one PRAGMA template),
 * with an optional comparison of application/SQLite cache profiles.
 *
 * Prerequisites:
 *   - Redis running on port 6379 (default)
 *
 * By default the script spawns one RESPlite process per PRAGMA template (default, performance, safety, minimal)
 * on consecutive ports. Use --template <name> to run only one template (e.g. default).
 *
 * Usage:
 *   node scripts/benchmark-redis-vs-resplite.js [--iterations N] [--redis-port P] [--resplite-port P] [--template NAME]
 *   node scripts/benchmark-redis-vs-resplite.js --template default --compare-caches [--cache-only] [--resplite-only]
 */

import { createClient } from 'redis';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPragmaTemplateNames } from '../src/storage/sqlite/pragmas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  iterations: 10000,
  redisPort: 6379,
  resplitePort: 6380,
  template: null, // null = all templates (except none); or 'default' | 'performance' | 'safety' | 'minimal'
  compareCaches: false,
  cacheOnly: false,
  respliteOnly: false,
};

const VALID_TEMPLATES = ['default', 'performance', 'safety', 'minimal'];

function parseArgs() {
  const out = { ...DEFAULTS };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iterations' && args[i + 1]) {
      out.iterations = parseInt(args[++i], 10);
    } else if (args[i] === '--redis-port' && args[i + 1]) {
      out.redisPort = parseInt(args[++i], 10);
    } else if (args[i] === '--resplite-port' && args[i + 1]) {
      out.resplitePort = parseInt(args[++i], 10);
    } else if (args[i] === '--template' && args[i + 1]) {
      const name = args[++i];
      if (!VALID_TEMPLATES.includes(name)) {
        console.error(`Invalid --template "${name}". Must be one of: ${VALID_TEMPLATES.join(', ')}`);
        process.exit(1);
      }
      out.template = name;
    } else if (args[i] === '--compare-caches') {
      out.compareCaches = true;
    } else if (args[i] === '--cache-only') {
      out.cacheOnly = true;
    } else if (args[i] === '--resplite-only') {
      out.respliteOnly = true;
    }
  }
  return out;
}

const CACHE_PROFILES = Object.freeze([
  {
    name: 'cache-off',
    description: 'RESPlite cache disabled; SQLite template unchanged',
    cache: false,
  },
  {
    name: 'cache-default',
    description: '50k entries, 64 MiB; per-collection limit 256 items / 256 KiB',
    cache: {},
  },
  {
    name: 'cache-production',
    description: '200k entries, 512 MiB; SQLite page cache 1 GiB + mmap 2 GiB',
    cache: {
      maxEntries: 200_000,
      maxBytes: 512 * 1024 * 1024,
      maxHashFields: 256,
      maxHashBytes: 256 * 1024,
    },
    pragma: {
      cache_size: -(1024 * 1024),
      mmap_size: 2 * 1024 * 1024 * 1024,
    },
  },
]);

function buildVariants({ template, compareCaches }) {
  if (compareCaches) {
    const templateName = template ?? 'default';
    return CACHE_PROFILES.map((profile) => ({ ...profile, templateName }));
  }

  const templateNames = template
    ? [template]
    : getPragmaTemplateNames().filter((name) => name !== 'none');
  return templateNames.map((templateName) => ({
    name: templateName,
    description: `PRAGMA template ${templateName}; default RESPlite cache`,
    templateName,
    cache: {},
  }));
}

async function connect(name, port) {
  const client = createClient({ socket: { port, host: '127.0.0.1' } });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch (err) {
    console.error(`Cannot connect to ${name} on port ${port}: ${err.message}`);
    process.exit(1);
  }
}

/** Wait until a port accepts connections or timeout. Returns true if ready. */
async function waitForPort(port, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const client = createClient({ socket: { port, host: '127.0.0.1' } });
      await client.connect();
      await client.ping();
      await client.quit();
      return true;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

/** Spawn one isolated RESPlite benchmark variant; returns child process. */
function spawnResplite(variant, port, dbPath) {
  const config = {
    port,
    dbPath,
    pragmaTemplate: variant.templateName,
    cache: variant.cache,
    ...(variant.pragma ? { pragma: variant.pragma } : {}),
  };
  const child = spawn(process.execPath, ['scripts/benchmark-resplite-instance.js'], {
    env: {
      ...process.env,
      RESPLITE_BENCH_CONFIG: JSON.stringify(config),
    },
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function formatNum(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  if (n >= 100) return n.toFixed(2);
  if (n >= 10) return n.toFixed(2);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

function formatMs(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
  if (ms >= 1) return ms.toFixed(2) + 'ms';
  return (ms * 1000).toFixed(0) + 'µs';
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(2) + ' KB';
  return n + ' B';
}

/** Parse Redis INFO memory reply (bulk string with key:value lines). */
function parseRedisInfoMemory(str) {
  const out = {};
  if (typeof str !== 'string') return out;
  for (const line of str.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Get Redis server memory (used_memory, used_memory_rss). */
async function getRedisMemory(client) {
  try {
    const raw = await client.sendCommand(['INFO', 'memory']);
    const s = typeof raw === 'string' ? raw : (raw && raw.toString ? raw.toString() : '');
    const info = parseRedisInfoMemory(s);
    return {
      used_memory: parseInt(info.used_memory, 10) || 0,
      used_memory_rss: parseInt(info.used_memory_rss, 10) || 0,
    };
  } catch (_) {
    return { used_memory: null, used_memory_rss: null };
  }
}

/** Get RESPlite server memory via MEMORY.INFO (array of key, value or object). */
async function getRespliteMemory(client) {
  try {
    const raw = await client.sendCommand(['MEMORY.INFO']);
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'heapUsed' in raw) {
      return { heapUsed: Number(raw.heapUsed) || 0, rss: Number(raw.rss) || 0 };
    }
    const list = Array.isArray(raw) ? raw : [];
    const out = {};
    for (let i = 0; i + 1 < list.length; i += 2) {
      const k = String(list[i]);
      const v = list[i + 1];
      out[k] = typeof v === 'number' ? v : parseInt(String(v), 10) || 0;
    }
    return {
      heapUsed: out.heapUsed ?? 0,
      rss: out.rss ?? 0,
    };
  } catch (_) {
    return { heapUsed: null, rss: null };
  }
}

/** Get RESPlite application-cache counters via CACHE.INFO. */
async function getRespliteCache(client) {
  try {
    const raw = await client.sendCommand(['CACHE.INFO']);
    const list = Array.isArray(raw) ? raw : [];
    const out = {};
    for (let i = 0; i + 1 < list.length; i += 2) {
      out[String(list[i])] = String(list[i + 1]);
    }
    return {
      enabled: out.enabled === '1',
      entries: Number(out.entries) || 0,
      bytes: Number(out.bytes) || 0,
      hits: Number(out.hits) || 0,
      misses: Number(out.misses) || 0,
      hitRatio: Number(out.hit_ratio) || 0,
    };
  } catch (_) {
    return null;
  }
}

async function runBench(name, client, iterations, fn) {
  const start = performance.now();
  await fn(client, iterations);
  const elapsed = performance.now() - start;
  const opsPerSec = (iterations / elapsed) * 1000;
  return { name, elapsed, opsPerSec, iterations };
}

async function benchPing(client, n) {
  for (let i = 0; i < n; i++) await client.ping();
}

async function benchSetGet(client, n) {
  const key = 'bm:str';
  for (let i = 0; i < n; i++) {
    await client.set(key, `value-${i}`);
    await client.get(key);
  }
}

async function benchGetHot(client, n) {
  const key = 'bm:str:hot';
  await client.set(key, 'hot-value');
  await client.get(key); // warm/read once before timing
  for (let i = 0; i < n; i++) await client.get(key);
}

async function benchMsetMget(client, n) {
  const keys = Array.from({ length: 10 }, (_, i) => `bm:mset:${i}`);
  for (let i = 0; i < n; i++) {
    const obj = Object.fromEntries(keys.map((k) => [k, `v-${i}-${k}`]));
    await client.mSet(obj);
    await client.mGet(keys);
  }
}

async function benchIncr(client, n) {
  const key = 'bm:incr';
  await client.set(key, '0');
  for (let i = 0; i < n; i++) await client.incr(key);
}

async function benchHsetHget(client, n) {
  const key = 'bm:hash';
  for (let i = 0; i < n; i++) {
    await client.hSet(key, `f${i % 20}`, `val-${i}`);
    await client.hGet(key, `f${i % 20}`);
  }
}

async function benchHgetUncached(client, n) {
  const key = 'bm:hash:hget:uncached';
  await client.del(key);
  await client.hSet(key, 'field', 'value');
  // HGET intentionally does not populate the complete-hash cache.
  for (let i = 0; i < n; i++) await client.hGet(key, 'field');
}

async function benchHgetHot(client, n) {
  const key = 'bm:hash:hget:hot';
  await client.del(key);
  await client.hSet(key, { field: 'value', second: 'another-value' });
  await client.hGetAll(key); // complete-hash cache warm-up
  for (let i = 0; i < n; i++) await client.hGet(key, 'field');
}

async function benchHmgetHot(client, n) {
  const key = 'bm:hash:hmget:hot';
  await client.del(key);
  await client.hSet(
    key,
    Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `v${i}`]))
  );
  await client.hGetAll(key); // complete-hash cache warm-up
  const fields = Array.from({ length: 10 }, (_, i) => `f${i}`);
  for (let i = 0; i < n; i++) await client.hmGet(key, fields);
}

async function benchHgetall(client, n) {
  const key = 'bm:hash:big';
  await client.del(key);
  await client.hSet(key, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `v${i}`])));
  await client.hGetAll(key); // keep the timed section strictly hot
  for (let i = 0; i < n; i++) await client.hGetAll(key);
}

async function benchHlen(client, n) {
  const key = 'bm:hash:hlen';
  await client.del(key);
  await client.hSet(key, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `v${i}`])));
  for (let i = 0; i < n; i++) await client.hLen(key);
}

async function benchHlenHot(client, n) {
  const key = 'bm:hash:hlen:hot';
  await client.del(key);
  await client.hSet(key, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `v${i}`])));
  await client.hGetAll(key); // complete-hash cache warm-up
  for (let i = 0; i < n; i++) await client.hLen(key);
}

async function benchSmembersHot(client, n) {
  const key = 'bm:set:members:hot';
  await client.del(key);
  await client.sAdd(key, Array.from({ length: 50 }, (_, i) => `m${i}`));
  await client.sMembers(key); // complete-set cache warm-up
  for (let i = 0; i < n; i++) await client.sMembers(key);
}

async function benchSismemberHot(client, n) {
  const key = 'bm:set:member:hot';
  await client.del(key);
  await client.sAdd(key, Array.from({ length: 50 }, (_, i) => `m${i}`));
  await client.sMembers(key); // complete-set cache warm-up
  for (let i = 0; i < n; i++) await client.sIsMember(key, `m${i % 50}`);
}

async function benchLrangeHot(client, n) {
  const key = 'bm:list:range:hot';
  await client.del(key);
  await client.rPush(key, Array.from({ length: 50 }, (_, i) => `item-${i}`));
  await client.lRange(key, 0, -1); // complete-list cache warm-up
  for (let i = 0; i < n; i++) await client.lRange(key, 0, 19);
}

async function benchLindexHot(client, n) {
  const key = 'bm:list:index:hot';
  await client.del(key);
  await client.rPush(key, Array.from({ length: 50 }, (_, i) => `item-${i}`));
  await client.lRange(key, 0, -1); // complete-list cache warm-up
  for (let i = 0; i < n; i++) await client.lIndex(key, i % 50);
}

async function benchZrangeHot(client, n) {
  const key = 'bm:zset:range:hot';
  await client.del(key);
  await client.zAdd(key, Array.from({ length: 100 }, (_, i) => ({ score: i, value: `m${i}` })));
  await client.zRange(key, 0, -1); // complete-sorted-set cache warm-up
  for (let i = 0; i < n; i++) await client.zRange(key, 0, 19);
}

async function benchZscoreHot(client, n) {
  const key = 'bm:zset:score:hot';
  await client.del(key);
  await client.zAdd(key, Array.from({ length: 100 }, (_, i) => ({ score: i, value: `m${i}` })));
  await client.zRange(key, 0, -1); // complete-sorted-set cache warm-up
  for (let i = 0; i < n; i++) await client.zScore(key, `m${i % 100}`);
}

async function benchSaddSmembers(client, n) {
  const key = 'bm:set';
  for (let i = 0; i < n; i++) {
    await client.sAdd(key, `m${i % 100}`);
    if (i % 10 === 0) await client.sMembers(key);
  }
}

async function benchLpushLrange(client, n) {
  const key = 'bm:list';
  await client.del(key);
  for (let i = 0; i < n; i++) {
    await client.lPush(key, `item-${i}`);
    if (i % 10 === 0) await client.lRange(key, 0, 99);
  }
}

async function benchLrem(client, n) {
  const key = 'bm:list:lrem';
  await client.del(key);
  // Pre-populate with a mix of values so LREM always finds something to do.
  // Each iteration pushes one 'target' element and removes it — net-zero list size.
  await client.rPush(key, Array.from({ length: 20 }, (_, i) => `item-${i}`));
  for (let i = 0; i < n; i++) {
    await client.rPush(key, 'target');
    await client.lRem(key, 1, 'target');
  }
}

async function benchZaddZrange(client, n) {
  const key = 'bm:zset';
  for (let i = 0; i < n; i++) {
    await client.zAdd(key, { score: i, value: `m${i}` });
    if (i % 10 === 0) await client.zRange(key, 0, 49);
  }
}

async function benchZaddZrevrange(client, n) {
  const key = 'bm:zset:rev';
  for (let i = 0; i < n; i++) {
    await client.zAdd(key, { score: i, value: `m${i}` });
    if (i % 10 === 0) await client.zRange(key, 0, 49, { REV: true });
  }
}

async function benchZrankZrevrank(client, n) {
  const key = 'bm:zset:rank';
  await client.del(key);
  await client.zAdd(key, Array.from({ length: 100 }, (_, i) => ({ score: i, value: `m${i}` })));
  for (let i = 0; i < n; i++) {
    const member = `m${i % 100}`;
    await client.zRank(key, member);
    await client.zRevRank(key, member);
  }
}

async function benchZrevrangebyscore(client, n) {
  const key = 'bm:zset:byscore';
  await client.del(key);
  await client.zAdd(key, Array.from({ length: 100 }, (_, i) => ({ score: i, value: `m${i}` })));
  for (let i = 0; i < n; i++) {
    await client.sendCommand(['ZREVRANGEBYSCORE', key, '99', '0', 'LIMIT', '0', '20']);
  }
}

async function benchDel(client, n) {
  for (let i = 0; i < n; i++) {
    await client.set(`bm:del:${i}`, 'x');
    await client.del(`bm:del:${i}`);
  }
}

async function benchStrlen(client, n) {
  const key = 'bm:strlen';
  await client.set(key, 'hello-world');
  for (let i = 0; i < n; i++) await client.sendCommand(['STRLEN', key]);
}

async function benchHkeys(client, n) {
  const key = 'bm:hash:keys';
  await client.del(key);
  await client.hSet(key, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `v${i}`])));
  for (let i = 0; i < n; i++) await client.sendCommand(['HKEYS', key]);
}

async function benchHvals(client, n) {
  const key = 'bm:hash:vals';
  await client.del(key);
  await client.hSet(key, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `v${i}`])));
  for (let i = 0; i < n; i++) await client.sendCommand(['HVALS', key]);
}

async function benchLset(client, n) {
  const key = 'bm:list:lset';
  await client.del(key);
  await client.rPush(key, Array.from({ length: 10 }, (_, i) => `item-${i}`));
  for (let i = 0; i < n; i++) await client.sendCommand(['LSET', key, '5', `val-${i}`]);
}

async function benchLtrim(client, n) {
  const key = 'bm:list:ltrim';
  for (let i = 0; i < n; i++) {
    await client.del(key);
    await client.rPush(key, Array.from({ length: 20 }, (_, j) => `x${j}`));
    await client.sendCommand(['LTRIM', key, '0', '9']);
  }
}

async function benchRename(client, n) {
  const a = 'bm:rename:a';
  const b = 'bm:rename:b';
  await client.set(a, 'v');
  for (let i = 0; i < n; i++) {
    await client.sendCommand(['RENAME', a, b]);
    await client.sendCommand(['RENAME', b, a]);
  }
}

async function benchZcount(client, n) {
  const key = 'bm:zset:count';
  await client.del(key);
  await client.zAdd(key, Array.from({ length: 100 }, (_, i) => ({ score: i, value: `m${i}` })));
  for (let i = 0; i < n; i++) await client.sendCommand(['ZCOUNT', key, '0', '99']);
}

async function benchZcard(client, n) {
  const key = 'bm:zset:card';
  await client.del(key);
  await client.zAdd(key, Array.from({ length: 100 }, (_, i) => ({ score: i, value: `m${i}` })));
  for (let i = 0; i < n; i++) await client.sendCommand(['ZCARD', key]);
}

async function benchZincrby(client, n) {
  const key = 'bm:zset:incr';
  await client.del(key);
  await client.zAdd(key, { score: 0, value: 'member' });
  for (let i = 0; i < n; i++) await client.sendCommand(['ZINCRBY', key, '1', 'member']);
}

async function benchZremrangebyrankPure(client, n) {
  const key = 'bm:zset:remrank:pure';
  const seed = Array.from({ length: 100 }, (_, j) => ({ score: j, value: `m${j}` }));
  const refill = Array.from({ length: 10 }, (_, j) => ({ score: j, value: `m${j}` }));
  await client.del(key);
  await client.zAdd(key, seed);
  for (let i = 0; i < n; i++) {
    await client.sendCommand(['ZREMRANGEBYRANK', key, '0', '9']);
    await client.zAdd(key, refill);
  }
}

async function benchZremrangebyscorePure(client, n) {
  const key = 'bm:zset:remscore:pure';
  const seed = Array.from({ length: 100 }, (_, j) => ({ score: j, value: `m${j}` }));
  const refill = Array.from({ length: 10 }, (_, j) => ({ score: j, value: `m${j}` }));
  await client.del(key);
  await client.zAdd(key, seed);
  for (let i = 0; i < n; i++) {
    await client.sendCommand(['ZREMRANGEBYSCORE', key, '0', '9']);
    await client.zAdd(key, refill);
  }
}

async function benchZremrangebyrankChurn(client, n) {
  const key = 'bm:zset:remrank';
  for (let i = 0; i < n; i++) {
    await client.del(key);
    await client.zAdd(key, Array.from({ length: 100 }, (_, j) => ({ score: j, value: `m${j}` })));
    await client.sendCommand(['ZREMRANGEBYRANK', key, '0', '9']);
  }
}

async function benchZremrangebyscoreChurn(client, n) {
  const key = 'bm:zset:remscore';
  for (let i = 0; i < n; i++) {
    await client.del(key);
    await client.zAdd(key, Array.from({ length: 100 }, (_, j) => ({ score: j, value: `m${j}` })));
    await client.sendCommand(['ZREMRANGEBYSCORE', key, '0', '9']);
  }
}

async function benchSpop(client, n) {
  const key = 'bm:set:spop';
  await client.del(key);
  await client.sAdd(key, Array.from({ length: 50 }, (_, i) => `m${i}`));
  for (let i = 0; i < n; i++) {
    const v = await client.sendCommand(['SPOP', key]);
    if (v === null || (Array.isArray(v) && v.length === 0)) {
      await client.sAdd(key, Array.from({ length: 50 }, (_, j) => `m${j}`));
    }
  }
}

async function benchSrandmember(client, n) {
  const key = 'bm:set:srand';
  await client.del(key);
  await client.sAdd(key, Array.from({ length: 50 }, (_, i) => `m${i}`));
  for (let i = 0; i < n; i++) await client.sendCommand(['SRANDMEMBER', key]);
}

async function benchHincrby(client, n) {
  const key = 'bm:hash:incr';
  const field = 'counter';
  await client.del(key);
  await client.hSet(key, field, '0');
  for (let i = 0; i < n; i++) await client.sendCommand(['HINCRBY', key, field, '1']);
}

const FT_INDEX = 'bm_ft_idx';
const FT_DOCS = 50;

async function benchFtSearch(client, n) {
  try {
    await client.sendCommand(['FT.CREATE', FT_INDEX, 'SCHEMA', 'payload', 'TEXT']);
  } catch (_) {
    // index already exists
  }
  for (let i = 1; i <= FT_DOCS; i++) {
    await client.sendCommand([
      'FT.ADD',
      FT_INDEX,
      `bm_ft_doc_${i}`,
      '1',
      'REPLACE',
      'FIELDS',
      'payload',
      `bench search term payload${i}`,
    ]);
  }
  for (let i = 0; i < n; i++) {
    await client.sendCommand([
      'FT.SEARCH',
      FT_INDEX,
      'bench',
      'NOCONTENT',
      'LIMIT',
      '0',
      '10',
    ]);
  }
}

const SUITES = [
  { name: 'PING', fn: benchPing, iterScale: 1 },
  { name: 'SET+GET', fn: benchSetGet, iterScale: 1, cacheFocus: true },
  { name: 'GET (hot)', fn: benchGetHot, iterScale: 1, cacheFocus: true },
  { name: 'MSET+MGET(10)', fn: benchMsetMget, iterScale: 1, cacheFocus: true },
  { name: 'INCR', fn: benchIncr, iterScale: 1 },
  { name: 'HSET+HGET', fn: benchHsetHget, iterScale: 1, cacheFocus: true },
  { name: 'HGET (uncached)', fn: benchHgetUncached, iterScale: 1, cacheFocus: true },
  { name: 'HGET (hot)', fn: benchHgetHot, iterScale: 1, cacheFocus: true },
  { name: 'HMGET(10) (hot)', fn: benchHmgetHot, iterScale: 1, cacheFocus: true },
  { name: 'HGETALL(50)', fn: benchHgetall, iterScale: 1, cacheFocus: true },
  { name: 'HLEN(50) (uncached)', fn: benchHlen, iterScale: 1, cacheFocus: true },
  { name: 'HLEN(50) (hot)', fn: benchHlenHot, iterScale: 1, cacheFocus: true },
  { name: 'SMEMBERS(50) (hot)', fn: benchSmembersHot, iterScale: 1, cacheFocus: true },
  { name: 'SISMEMBER(50) (hot)', fn: benchSismemberHot, iterScale: 1, cacheFocus: true },
  { name: 'LRANGE(20/50) (hot)', fn: benchLrangeHot, iterScale: 1, cacheFocus: true },
  { name: 'LINDEX(50) (hot)', fn: benchLindexHot, iterScale: 1, cacheFocus: true },
  { name: 'ZRANGE(20/100) (hot)', fn: benchZrangeHot, iterScale: 1, cacheFocus: true },
  { name: 'ZSCORE(100) (hot)', fn: benchZscoreHot, iterScale: 1, cacheFocus: true },
  { name: 'SADD+SMEMBERS', fn: benchSaddSmembers, iterScale: 1 },
  { name: 'LPUSH+LRANGE', fn: benchLpushLrange, iterScale: 1 },
  { name: 'LREM', fn: benchLrem, iterScale: 1 },
  { name: 'ZADD+ZRANGE', fn: benchZaddZrange, iterScale: 1 },
  { name: 'ZADD+ZREVRANGE', fn: benchZaddZrevrange, iterScale: 1 },
  { name: 'ZRANK+ZREVRANK', fn: benchZrankZrevrank, iterScale: 1 },
  { name: 'ZREVRANGEBYSCORE', fn: benchZrevrangebyscore, iterScale: 1 },
  { name: 'SET+DEL', fn: benchDel, iterScale: 1 },
  { name: 'STRLEN', fn: benchStrlen, iterScale: 1, cacheFocus: true },
  { name: 'HKEYS(50)', fn: benchHkeys, iterScale: 1, cacheFocus: true },
  { name: 'HVALS(50)', fn: benchHvals, iterScale: 1, cacheFocus: true },
  { name: 'LSET', fn: benchLset, iterScale: 1 },
  { name: 'LTRIM', fn: benchLtrim, iterScale: 1 },
  { name: 'RENAME', fn: benchRename, iterScale: 1 },
  { name: 'ZCOUNT', fn: benchZcount, iterScale: 1 },
  { name: 'ZCARD(100)', fn: benchZcard, iterScale: 1 },
  { name: 'ZINCRBY', fn: benchZincrby, iterScale: 1 },
  { name: 'ZREMRANGEBYRANK (pure)', fn: benchZremrangebyrankPure, iterScale: 1 },
  { name: 'ZREMRANGEBYSCORE (pure)', fn: benchZremrangebyscorePure, iterScale: 1 },
  { name: 'ZREMRANGEBYRANK (churn)', fn: benchZremrangebyrankChurn, iterScale: 1 },
  { name: 'ZREMRANGEBYSCORE (churn)', fn: benchZremrangebyscoreChurn, iterScale: 1 },
  { name: 'SPOP', fn: benchSpop, iterScale: 1 },
  { name: 'SRANDMEMBER', fn: benchSrandmember, iterScale: 1 },
  { name: 'HINCRBY', fn: benchHincrby, iterScale: 1 },
  { name: 'FT.SEARCH', fn: benchFtSearch, iterScale: 1 },
];

async function runSuite(redis, respliteClients, suite, iterations) {
  const n = Math.max(1, Math.floor(iterations * (suite.iterScale ?? 1)));
  const redisResult = redis
    ? await runBench('Redis', redis, n, suite.fn).catch((e) => ({
      name: 'Redis',
      error: e?.message || String(e),
    }))
    : null;
  const templateResults = {};
  await Promise.all(
    respliteClients.map(async ({ name, client }) => {
      const result = await runBench(`RESPlite(${name})`, client, n, suite.fn).catch((e) => ({
        name: name,
        error: e?.message || String(e),
      }));
      templateResults[name] = result;
    })
  );
  return { suite: suite.name, redis: redisResult, templates: templateResults };
}

async function main() {
  const options = parseArgs();
  const { iterations, redisPort, resplitePort, template, compareCaches, cacheOnly, respliteOnly } = options;
  const variants = buildVariants(options);
  const variantNames = variants.map((variant) => variant.name);
  const suites = cacheOnly ? SUITES.filter((suite) => suite.cacheFocus) : SUITES;

  const benchTmpDir = path.join(PROJECT_ROOT, 'tmp', 'bench');
  fs.mkdirSync(benchTmpDir, { recursive: true });

  const title = compareCaches
    ? `RESPlite cache comparison (PRAGMA template: ${template ?? 'default'})`
    : (template ? `Redis vs RESPlite (template: ${template})` : 'Redis vs RESPlite (all PRAGMA templates)');
  console.log(`Benchmark: ${title}`);
  console.log(`  Redis:    ${respliteOnly ? 'skipped (--resplite-only)' : `127.0.0.1:${redisPort}`}`);
  console.log(`  RESPlite: ${variants.length} process(es) on port(s) ${resplitePort}${variants.length > 1 ? `..${resplitePort + variants.length - 1}` : ''}`);
  console.log('  Variants:');
  for (const variant of variants) {
    console.log(`    ${variant.name}: ${variant.description}`);
  }
  console.log(`  Iterations per suite: ${iterations}`);
  if (cacheOnly) console.log(`  Suites: cache-focused only (${suites.length})`);
  console.log('');

  const children = [];
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    const name = variant.name;
    const port = resplitePort + i;
    const dbPath = path.join(benchTmpDir, `bench-${name}.db`);
    const child = spawnResplite(variant, port, dbPath);
    child.on('error', (err) => console.error(`RESPlite(${name}) spawn error:`, err.message));
    children.push({ name, port, child, variant });
  }

  console.log('  Waiting for RESPlite instances to start...');
  for (const { name, port } of children) {
    const ready = await waitForPort(port);
    if (!ready) {
      console.error(`RESPlite(${name}) on port ${port} did not become ready in time.`);
      for (const { child } of children) child.kill();
      process.exit(1);
    }
  }

  const redis = respliteOnly ? null : await connect('Redis', redisPort);
  const respliteClients = await Promise.all(
    children.map(async ({ name, port }) => ({ name, client: await connect(`RESPlite(${name})`, port) }))
  );

  const prefix = 'bm:';
  if (redis) {
    try {
      const redisKeys = await redis.keys(prefix + '*');
      if (redisKeys.length) await redis.del(redisKeys);
    } catch (_) {}
  }
  for (const { client } of respliteClients) {
    try {
      const keys = await client.keys(prefix + '*');
      if (keys.length) await client.del(keys);
    } catch (_) {}
  }

  const memBefore = {
    process: process.memoryUsage(),
    redis: redis ? await getRedisMemory(redis) : null,
    resplite: Object.fromEntries(await Promise.all(
      respliteClients.map(async ({ name, client }) => [name, await getRespliteMemory(client)])
    )),
  };

  const results = [];
  for (const suite of suites) {
    process.stdout.write(`  ${suite.name} ... `);
    try {
      const row = await runSuite(redis, respliteClients, suite, iterations);
      results.push(row);
      const rStr = !row.redis ? null : (row.redis.error ? 'skip' : formatNum(row.redis.opsPerSec) + '/s');
      const templateStrs = variantNames.map(
        (t) => (row.templates[t]?.error ? '—' : formatNum(row.templates[t]?.opsPerSec) + '/s')
      );
      const parts = variantNames.map((name, i) => `${name} ${templateStrs[i]}`);
      if (rStr) parts.unshift(`Redis ${rStr}`);
      console.log(parts.join(' | '));
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results.push({ suite: suite.name, error: e.message });
    }
  }

  const memAfter = {
    process: process.memoryUsage(),
    redis: redis ? await getRedisMemory(redis) : null,
    resplite: Object.fromEntries(await Promise.all(
      respliteClients.map(async ({ name, client }) => [name, await getRespliteMemory(client)])
    )),
    cache: Object.fromEntries(await Promise.all(
      respliteClients.map(async ({ name, client }) => [name, await getRespliteCache(client)])
    )),
  };

  if (redis) await redis.quit();
  for (const { client } of respliteClients) await client.quit();
  for (const { child } of children) child.kill();

  const headerCols = ['Suite', ...(redis ? ['Redis'] : []), ...variantNames];
  const summaryRows = results.map((r) => {
    if (r.error) return { suite: r.suite, values: [`ERROR: ${r.error}`] };
    const redisVals = !r.redis ? [] : [r.redis.error ? '—' : formatNum(r.redis.opsPerSec)];
    const templateVals = variantNames.map((t) => (r.templates[t]?.error ? '—' : formatNum(r.templates[t]?.opsPerSec)));
    return { suite: r.suite, values: [...redisVals, ...templateVals] };
  });

  const suiteWidth = Math.max(
    headerCols[0].length,
    ...summaryRows.map((r) => r.suite.length)
  );
  const valueWidths = headerCols.slice(1).map((h, idx) =>
    Math.max(
      h.length,
      ...summaryRows.map((r) => (r.values[idx] || '').length)
    )
  );

  console.log('');
  console.log('--- Summary (ops/sec) ---');
  console.log([
    headerCols[0].padEnd(suiteWidth),
    ...headerCols.slice(1).map((h, idx) => h.padStart(valueWidths[idx])),
  ].join(' | '));
  console.log([
    '-'.repeat(suiteWidth),
    ...valueWidths.map((w) => '-'.repeat(w)),
  ].join('-|-'));

  for (const row of summaryRows) {
    console.log([
      row.suite.padEnd(suiteWidth),
      ...row.values.map((v, idx) => v.padStart(valueWidths[idx])),
    ].join(' | '));
  }

  if (compareCaches && variantNames.includes('cache-off')) {
    console.log('');
    console.log('--- Cache uplift vs cache-off ---');
    for (const result of results) {
      if (result.error) continue;
      const baseline = result.templates['cache-off'];
      if (!baseline || baseline.error || !baseline.opsPerSec) continue;
      const uplifts = variantNames
        .filter((name) => name !== 'cache-off')
        .map((name) => {
          const candidate = result.templates[name];
          if (!candidate || candidate.error) return `${name} —`;
          const pct = ((candidate.opsPerSec / baseline.opsPerSec) - 1) * 100;
          return `${name} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
        });
      console.log(`  ${result.suite}: ${uplifts.join(' | ')}`);
    }
  }

  console.log('');
  console.log('--- Memory (after benchmark) ---');
  if (memAfter.redis?.used_memory != null) {
    console.log(`  Redis:    used_memory ${formatBytes(memAfter.redis.used_memory)}, rss ${formatBytes(memAfter.redis.used_memory_rss)}`);
  } else if (redis) {
    console.log('  Redis:    (INFO memory not available)');
  }
  for (const name of variantNames) {
    const memory = memAfter.resplite[name];
    const before = memBefore.resplite[name];
    if (memory?.rss != null) {
      const rssDelta = before?.rss == null ? null : memory.rss - before.rss;
      const deltaText = rssDelta == null ? '' : `, rss delta ${rssDelta >= 0 ? '+' : ''}${formatBytes(rssDelta)}`;
      console.log(`  ${name}: heapUsed ${formatBytes(memory.heapUsed)}, rss ${formatBytes(memory.rss)}${deltaText}`);
    } else {
      console.log(`  ${name}: (MEMORY.INFO not available)`);
    }
  }

  console.log('');
  console.log('--- RESPlite application cache (after benchmark) ---');
  for (const name of variantNames) {
    const cache = memAfter.cache[name];
    if (!cache) {
      console.log(`  ${name}: (CACHE.INFO not available)`);
      continue;
    }
    console.log(
      `  ${name}: enabled ${cache.enabled ? 'yes' : 'no'}, entries ${cache.entries}, `
      + `bytes ${formatBytes(cache.bytes)}, hits ${cache.hits}, misses ${cache.misses}, `
      + `hit ratio ${(cache.hitRatio * 100).toFixed(2)}%`
    );
  }
  console.log(`  Process:  heapUsed ${formatBytes(memAfter.process.heapUsed)}, rss ${formatBytes(memAfter.process.rss)}`);

  const deltaProcess = memAfter.process.heapUsed - memBefore.process.heapUsed;
  console.log(`  Delta (process): ${deltaProcess >= 0 ? '+' : ''}${formatBytes(deltaProcess)}`);
  console.log('');
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
