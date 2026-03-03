#!/usr/bin/env node
/**
 * Comparative benchmark: Redis (local) vs RESPlite (all PRAGMA templates).
 *
 * Prerequisites:
 *   - Redis running on port 6379 (default)
 *
 * The script spawns one RESPlite process per PRAGMA template (default, performance, safety, minimal)
 * on consecutive ports (6380, 6381, 6382, 6383 by default) and runs the same workload against each.
 *
 * Usage:
 *   node scripts/benchmark-redis-vs-resplite.js [--iterations N] [--redis-port P] [--resplite-port P]
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
};

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
    }
  }
  return out;
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

/** Spawn RESPlite with given PRAGMA template; returns child process. */
function spawnResplite(templateName, port, dbPath) {
  const child = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      RESPLITE_PORT: String(port),
      RESPLITE_DB: dbPath,
      RESPLITE_PRAGMA_TEMPLATE: templateName,
    },
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return String(n);
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

async function benchHgetall(client, n) {
  const key = 'bm:hash:big';
  await client.del(key);
  await client.hSet(key, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `v${i}`])));
  for (let i = 0; i < n; i++) await client.hGetAll(key);
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

async function benchZaddZrange(client, n) {
  const key = 'bm:zset';
  for (let i = 0; i < n; i++) {
    await client.zAdd(key, { score: i, value: `m${i}` });
    if (i % 10 === 0) await client.zRange(key, 0, 49);
  }
}

async function benchDel(client, n) {
  for (let i = 0; i < n; i++) {
    await client.set(`bm:del:${i}`, 'x');
    await client.del(`bm:del:${i}`);
  }
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
  { name: 'SET+GET', fn: benchSetGet, iterScale: 1 },
  { name: 'MSET+MGET(10)', fn: benchMsetMget, iterScale: 1 },
  { name: 'INCR', fn: benchIncr, iterScale: 1 },
  { name: 'HSET+HGET', fn: benchHsetHget, iterScale: 1 },
  { name: 'HGETALL(50)', fn: benchHgetall, iterScale: 1 },
  { name: 'SADD+SMEMBERS', fn: benchSaddSmembers, iterScale: 1 },
  { name: 'LPUSH+LRANGE', fn: benchLpushLrange, iterScale: 1 },
  { name: 'ZADD+ZRANGE', fn: benchZaddZrange, iterScale: 1 },
  { name: 'SET+DEL', fn: benchDel, iterScale: 1 },
  { name: 'FT.SEARCH', fn: benchFtSearch, iterScale: 1 },
];

async function runSuite(redis, respliteClients, suite, iterations) {
  const n = Math.max(1, Math.floor(iterations * (suite.iterScale ?? 1)));
  const redisResult = await runBench('Redis', redis, n, suite.fn).catch((e) => ({
    name: 'Redis',
    error: e?.message || String(e),
  }));
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
  const { iterations, redisPort, resplitePort } = parseArgs();
  const templateNames = getPragmaTemplateNames().filter((t) => t !== 'none');

  const benchTmpDir = path.join(PROJECT_ROOT, 'tmp', 'bench');
  fs.mkdirSync(benchTmpDir, { recursive: true });

  console.log('Benchmark: Redis vs RESPlite (all PRAGMA templates)');
  console.log(`  Redis:    127.0.0.1:${redisPort}`);
  console.log(`  RESPlite: one process per template on ports ${resplitePort}..${resplitePort + templateNames.length - 1}`);
  console.log(`  Templates: ${templateNames.join(', ')}`);
  console.log(`  Iterations per suite: ${iterations}`);
  console.log('');

  const children = [];
  for (let i = 0; i < templateNames.length; i++) {
    const name = templateNames[i];
    const port = resplitePort + i;
    const dbPath = path.join(benchTmpDir, `bench-${name}.db`);
    const child = spawnResplite(name, port, dbPath);
    child.on('error', (err) => console.error(`RESPlite(${name}) spawn error:`, err.message));
    children.push({ name, port, child });
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

  const redis = await connect('Redis', redisPort);
  const respliteClients = await Promise.all(
    children.map(async ({ name, port }) => ({ name, client: await connect(`RESPlite(${name})`, port) }))
  );

  const prefix = 'bm:';
  try {
    const redisKeys = await redis.keys(prefix + '*');
    if (redisKeys.length) await redis.del(redisKeys);
  } catch (_) {}
  for (const { client } of respliteClients) {
    try {
      const keys = await client.keys(prefix + '*');
      if (keys.length) await client.del(keys);
    } catch (_) {}
  }

  const memBefore = {
    process: process.memoryUsage(),
    redis: await getRedisMemory(redis),
    resplite: await getRespliteMemory(respliteClients[0]?.client),
  };

  const results = [];
  for (const suite of SUITES) {
    process.stdout.write(`  ${suite.name} ... `);
    try {
      const row = await runSuite(redis, respliteClients, suite, iterations);
      results.push(row);
      const rStr = row.redis.error ? `skip` : formatNum(row.redis.opsPerSec) + '/s';
      const templateStrs = templateNames.map(
        (t) => (row.templates[t]?.error ? '—' : formatNum(row.templates[t]?.opsPerSec) + '/s')
      );
      console.log(`Redis ${rStr} | ${templateNames.map((t, i) => `${t} ${templateStrs[i]}`).join(' | ')}`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results.push({ suite: suite.name, error: e.message });
    }
  }

  const memAfter = {
    process: process.memoryUsage(),
    redis: await getRedisMemory(redis),
    resplite: await getRespliteMemory(respliteClients[0]?.client),
  };

  await redis.quit();
  for (const { client } of respliteClients) await client.quit();
  for (const { child } of children) child.kill();

  const colWidth = 10;
  const headerCols = ['Suite', 'Redis', ...templateNames];
  const sep = headerCols.map((_, i) => (i === 0 ? '-'.repeat(18) : '-'.repeat(colWidth))).join('|');
  console.log('');
  console.log('--- Summary (ops/sec) ---');
  console.log(headerCols.map((h, i) => (i === 0 ? h.padEnd(18) : h.padStart(colWidth))).join(' | '));
  console.log(sep);
  for (const r of results) {
    if (r.error) {
      console.log(`${r.suite.padEnd(18)} | ERROR: ${r.error}`);
      continue;
    }
    const redisVal = r.redis.error ? '—' : formatNum(r.redis.opsPerSec);
    const templateVals = templateNames.map((t) => (r.templates[t]?.error ? '—' : formatNum(r.templates[t]?.opsPerSec)));
    console.log(
      [r.suite.padEnd(18), redisVal.padStart(colWidth), ...templateVals.map((v) => v.padStart(colWidth))].join(' | ')
    );
  }

  console.log('');
  console.log('--- Memory (after benchmark) ---');
  if (memAfter.redis.used_memory != null) {
    console.log(`  Redis:    used_memory ${formatBytes(memAfter.redis.used_memory)}, rss ${formatBytes(memAfter.redis.used_memory_rss)}`);
  } else {
    console.log('  Redis:    (INFO memory not available)');
  }
  if (memAfter.resplite?.rss != null) {
    console.log(`  RESPlite: heapUsed ${formatBytes(memAfter.resplite.heapUsed)}, rss ${formatBytes(memAfter.resplite.rss)} (first instance)`);
  } else {
    console.log('  RESPlite: (MEMORY.INFO not available)');
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
