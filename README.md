# RESPLite

A RESP server backed by SQLite. Compatible with `redis` clients and `redis-cli`, persistent by default, zero external daemons, and minimal memory footprint.

## Overview

RESPLite speaks **RESP** (the Redis Serialization Protocol), so your existing `redis` npm client and `redis-cli` work without changes. The storage layer is **SQLite**: WAL mode, FTS5 for full-text search, and a single `.db` file that survives restarts without snapshots or AOF.

It is not a Redis clone. It covers a practical subset of commands that map naturally to SQLite, suited for single-node workloads where Redis' in-memory latency is not a hard requirement.

- **Zero external services** — just Node.js and a `.db` file.
- **Drop-in compatible** — works with the official `redis` npm client and `redis-cli`.
- **Persistent by default** — no snapshots, no AOF, no config.
- **Embeddable** — start the server and connect from the same script.
- **Full-text search** — FT.\* commands via SQLite FTS5.
- **Simple queues** — lists with BLPOP/BRPOP.

### When RESPLite beats Redis in Docker

Building this project surfaced a clear finding: **Redis running inside Docker** on the same host often has **worse latency** than **RESPLite running locally**. Docker's virtual network adds overhead that disappears when the server runs in the same process/host. For single-node workloads this makes RESPLite the faster, simpler option.

The strongest use case is **migrating a non-replicated Redis instance that has grown large** (tens of GB). You don't need to manage replicas, AOF, or RDB. Once migrated, you get a single SQLite file and latency that is good enough for most workloads. The built-in migration tooling (see [Migration from Redis](#migration-from-redis)) handles datasets of that size with minimal downtime.

### Benchmark snapshot

Representative results against Redis in Docker on the same host:

| Suite         | Redis (Docker) | RESPLite (default) |
|---------------|----------------|--------------------|
| PING          | 8.79K/s        | 37.36K/s           |
| SET+GET       | 4.68K/s        | 11.96K/s           |
| HSET+HGET     | 4.40K/s        | 11.91K/s           |
| ZADD+ZRANGE   | 7.80K/s        | 17.12K/s           |
| FT.SEARCH     | 8.36K/s        | 8.22K/s            |

The full benchmark table is available later in [Benchmark](#benchmark-redis-vs-resplite).

## Install

```bash
npm install resplite
```

## AI Skill

```bash
npx skills add https://github.com/clasen/RESPLite
```

## JavaScript quick start

The recommended way to use RESPLite is from your own Node.js script, creating the server with the options and observability hooks your app needs. If you prefer a standalone server or terminal workflow, see [CLI and standalone server reference](#cli-and-standalone-server-reference) below.

### Recommended server script

In a typical app, you start RESPLite from your own process and attach hooks for observability. The client still receives the same RESP responses; hooks are for logging and monitoring only.

```javascript
import LemonLog from 'lemonlog';
const log = new LemonLog('RESPlite');

const srv = await createRESPlite({
  port: 6380,
  db: './data.db',
  hooks: {
    onUnknownCommand({ command, argv, clientAddress }) {
      log.warn({ command, argv, clientAddress }, 'unsupported command');
    },
    onCommandError({ command, argv, error, clientAddress }) {
      log.warn({ command, argv, error, clientAddress }, 'command error');
    },
    onSocketError({ error, clientAddress }) {
      log.error({ error, clientAddress }, 'connection error');
    },
  },
});
```

Available hooks:

- `onUnknownCommand`: client sent a command not implemented by RESPLite, such as `SUBSCRIBE` or `PUBLISH`. Payload includes `argv` (full command line as strings, e.g. `['CLIENT','LIST']`) so you can log exactly what was sent.
- `onCommandError`: a command failed because of wrong type, invalid args, or a handler error. Payload includes `argv` for the full command line.
- `onSocketError`: the connection socket emitted an error, for example `ECONNRESET`.

If you want a tiny in-process smoke test that starts RESPLite and connects with the `redis` client in the same script, see [Minimal embedded example](#minimal-embedded-example) below.

## Migration from Redis

RESPLite is a good fit for migrating **non-replicated Redis** instances that have **grown large** (e.g. tens of GB) and where RESPLite's latency is acceptable. The recommended path is to drive the migration from a Node.js script via `resplite/migration`, keeping preflight, dirty tracking, bulk import, cutover, and verification in one place.

### Recommended migration script

The full flow can run from a single script: inspect Redis, enable keyspace notifications, track dirty keys in-process, bulk import with checkpoints, apply dirty keys during cutover, verify, and disconnect cleanly.

```javascript
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createMigration } from 'resplite/migration';

const m = createMigration({
  from:  'redis://127.0.0.1:6379',  // source Redis URL (default)
  to:    './resplite.db',           // destination SQLite DB path (required)
  runId: 'my-migration-1',          // unique run ID (required for bulk/status/applyDirty)

  // optional
  scanCount:      5000,
  batchKeys:      1000,
  batchBytes:     64 * 1024 * 1024,  // 64 MB
  maxRps:         0,                  // 0 = unlimited
  concurrency:    8,                  // parallel key imports during bulk
  // estimatedTotalKeys: info.keyCountEstimate, // optional ETA baseline (can also be set per bulk call)

  // If your Redis deployment renamed CONFIG for security:
  // configCommand: 'MYCONFIG',
});

// Step 0 — Preflight: inspect Redis before starting
const info = await m.preflight();
console.log('keys (estimate):', info.keyCountEstimate);
console.log('type distribution:', info.typeDistribution);
console.log('notify-keyspace-events:', info.notifyKeyspaceEvents);
console.log('CONFIG available:', info.configCommandAvailable);  // false if renamed
console.log('recommended params:', info.recommended);

// Step 0b — Enable keyspace notifications (required for dirty-key tracking)
// Reads the current value and merges the new flags — existing flags are preserved.
const ks = await m.enableKeyspaceNotifications();
// → { ok: true, previous: '', applied: 'KEA' }
// If CONFIG is renamed and configCommand was not set, ok=false and error explains how to fix it.

// Start dirty tracking (in-process, same script)
let dirtyLogging = true;
await m.startDirtyTracker({
  onProgress: (p) => {
    if (dirtyLogging) {
      console.log(`[dirty ${p.totalEvents}] event=${p.event} key=${p.key}`);
    }
  },
});

// Step 1 — Bulk import (checkpointed, resumable). Same script to start or continue.
// Use keyCountEstimate from preflight to compute ETA/progress during bulk.
await m.bulk({
  estimatedTotalKeys: info.keyCountEstimate,
  onProgress: (r) => {
    const pct = r.progress_pct != null ? r.progress_pct.toFixed(1) : '—';
    const eta = r.eta_seconds != null ? `${r.eta_seconds}s` : '—';
    console.log(
      `scanned=${r.scanned_keys} migrated=${r.migrated_keys} errors=${r.error_keys} progress=${pct}% eta=${eta} rate=${r.keys_per_second.toFixed(1)} keys/s`
    );
  },
});

// Check status at any point (synchronous, no Redis needed)
const { run, dirty } = m.status();
console.log('bulk status:', run.status, '— dirty counts:', dirty);

// Stop dirty progress logs so the next prompt is visible (tracker keeps recording until stopDirtyTracker)
dirtyLogging = false;

// Step 2 — Pause for cutover:
// stop the app that is still writing to Redis, then press Enter.
// (readline reads from stdin, so Enter is captured even if anything else writes to stdout.)
const rl = createInterface({ input: stdin, output: stdout });
await rl.question('Stop app traffic to Redis, then press Enter to apply the final dirty set...');
rl.close();

// Step 3 — Apply dirty keys that changed in Redis during bulk
await m.applyDirty({ onProgress: console.log });

// Step 3b — Stop tracker after cutover
await m.stopDirtyTracker();

// If the source also uses FT.*, this is where you would run m.migrateSearch().
// Step 3c — Migrate RediSearch indices after writes are frozen
await m.migrateSearch({
  onProgress: (r) => {
    console.log(`[search ${r.name}] docs=${r.docsImported} skipped=${r.docsSkipped} warnings=${r.warnings.length}`);
  },
});

// Step 4 — Verify a sample of keys match between Redis and the destination
const result = await m.verify({ samplePct: 0.5, maxSample: 10000 });
console.log(`verified ${result.sampled} keys — mismatches: ${result.mismatches.length}`);

// Disconnect Redis when done
await m.close();
```

**Bulk: Automatic resume (default)**  
`resume` defaults to `true`. It doesn't matter whether it's the first run or a resume: the same script works for both starting and continuing. The first run starts from cursor 0; if the process is interrupted (Ctrl+C, crash, etc.), running the script again continues from the last checkpoint. You don't need to pass `resume: false` on the first run or change anything to resume.

**Graceful shutdown**  
On SIGINT (Ctrl+C) or SIGTERM, the bulk importer checkpoints progress, sets the run status to `aborted`, closes the SQLite database cleanly (so WAL is checkpointed and the file is not left open), then exits. You can safely interrupt a long-running bulk and resume later.

The JS API can run the dirty-key tracker in-process via `m.startDirtyTracker()` / `m.stopDirtyTracker()`, so the full flow stays inside a single script.

For a real cutover, the simplest flow is: let bulk finish, stop the app that still writes to Redis, press Enter to apply the final dirty set, run `migrateSearch()` if you use `FT.*`, and then switch traffic to RESPLite.

The KV bulk flow imports strings, hashes, sets, lists, and zsets. If your source also uses `FT.*` indices, see [Migrating RediSearch indices](#migrating-redisearch-indices).

#### Renamed CONFIG command

If your Redis instance has the `CONFIG` command renamed (a common hardening practice), pass the new name to `createMigration`:

```javascript
const m = createMigration({
  from: 'redis://10.0.0.10:6379',
  to:   './resplite.db',
  runId: 'run_001',
  configCommand: 'MYCONFIG',  // the renamed command
});

// preflight will use MYCONFIG GET notify-keyspace-events
const info = await m.preflight();
// info.configCommandAvailable → false if the name is wrong

// enableKeyspaceNotifications will use MYCONFIG SET notify-keyspace-events KEA
const result = await m.enableKeyspaceNotifications({ value: 'KEA' });
```

The same `configCommand` override is used by `preflight()` and `enableKeyspaceNotifications()` in the programmatic flow.

#### Low-level re-exports

If you need more control, the individual functions and registry helpers are also exported:

```javascript
import {
  runPreflight, runBulkImport, runApplyDirty, runVerify,
  getRun, getDirtyCounts, createRun, setRunStatus, logError,
} from 'resplite/migration';
```

## JavaScript examples

Once connected through the `redis` client, you can use RESPLite with the usual Redis-style API.

### Minimal embedded example

```javascript
import { createClient } from 'redis';
import { createRESPlite } from 'resplite/embed';

const srv = await createRESPlite({ db: './my-app.db' });
const client = createClient({ socket: { port: srv.port, host: '127.0.0.1' } });
await client.connect();

await client.set('hello', 'world');
console.log(await client.get('hello'));  // → "world"

await client.quit();
await srv.close();
```

### Strings, TTL, and key operations

```javascript
// SET with expiration
await client.set('session:abc', JSON.stringify({ user: 'alice' }));
await client.expire('session:abc', 3600);      // expire in 1 hour
console.log(await client.ttl('session:abc'));  // → 3600 (approx)

// Atomic counters
await client.set('visits', '0');
await client.incr('visits');
await client.incrBy('visits', 10);
console.log(await client.get('visits'));       // → "11"

// Multi-key operations
await client.mSet(['k1', 'v1', 'k2', 'v2']);
const values = await client.mGet(['k1', 'k2', 'missing']);
console.log(values);  // → ["v1", "v2", null]

// Key existence and deletion
console.log(await client.exists('k1'));        // → 1
await client.del('k1');
console.log(await client.exists('k1'));        // → 0
```

### Hashes

```javascript
await client.hSet('user:1', { name: 'Martin', age: '42', city: 'BCN' });

console.log(await client.hGet('user:1', 'name'));     // → "Martin"

const user = await client.hGetAll('user:1');
console.log(user);  // → { name: "Martin", age: "42", city: "BCN" }

await client.hIncrBy('user:1', 'age', 1);
console.log(await client.hGet('user:1', 'age'));      // → "43"

console.log(await client.hExists('user:1', 'email')); // → false
```

### Sets

```javascript
await client.sAdd('tags', ['node', 'sqlite', 'redis']);
console.log(await client.sMembers('tags'));           // → ["node", "sqlite", "redis"]
console.log(await client.sIsMember('tags', 'node'));  // → true
console.log(await client.sCard('tags'));              // → 3

await client.sRem('tags', 'redis');
console.log(await client.sCard('tags'));              // → 2
```

### Lists

```javascript
await client.lPush('queue', ['c', 'b', 'a']);      // push left: a, b, c
await client.rPush('queue', ['d', 'e']);           // push right: d, e

console.log(await client.lLen('queue'));           // → 5
console.log(await client.lRange('queue', 0, -1));  // → ["a", "b", "c", "d", "e"]
console.log(await client.lIndex('queue', 0));      // → "a"

console.log(await client.lPop('queue'));           // → "a"
console.log(await client.rPop('queue'));           // → "e"
```

### Blocking list commands (BLPOP / BRPOP)

`BLPOP` and `BRPOP` block until an element is available or a timeout (seconds) is reached. Use them for simple queues or coordination between producers and consumers.

```javascript
// Consumer: block up to 10 seconds for an element from "tasks" or "fallback"
const result = await client.blPop(['tasks', 'fallback'], 10);
// result is { key: 'tasks', element: 'item1' } or null on timeout

// Producer (e.g. another client or process)
await client.rPush('tasks', 'item1');
```

- **Timeout**: `0` = block indefinitely; `> 0` = block up to that many seconds.
- **Return**: `{ key, element }` on success, or `null` on timeout.
- **Multi-key**: Keys are checked in order; the first key that has an element wins. One push wakes at most one blocked client (FIFO per key).

### Sorted sets

```javascript
await client.zAdd('leaderboard', [
  { score: 100, value: 'alice' },
  { score: 250, value: 'bob' },
  { score: 175, value: 'carol' },
]);

console.log(await client.zCard('leaderboard'));                // → 3
console.log(await client.zScore('leaderboard', 'bob'));        // → 250
console.log(await client.zRange('leaderboard', 0, -1));        // → ["alice", "carol", "bob"]
console.log(await client.zRangeByScore('leaderboard', 100, 200)); // → ["alice", "carol"]
```

### Full-text search (RediSearch-like)

```javascript
// Create an index
await client.sendCommand(['FT.CREATE', 'articles', 'SCHEMA', 'payload', 'TEXT']);

// Add documents
await client.sendCommand([
  'FT.ADD', 'articles', 'doc:1', '1', 'REPLACE', 'FIELDS',
  'payload', 'Introduction to SQLite full-text search'
]);
await client.sendCommand([
  'FT.ADD', 'articles', 'doc:2', '1', 'REPLACE', 'FIELDS',
  'payload', 'Building a Redis-compatible server in Node.js'
]);

// Search
const results = await client.sendCommand([
  'FT.SEARCH', 'articles', 'SQLite', 'NOCONTENT', 'LIMIT', '0', '10'
]);
console.log(results);  // → [1, "doc:1"]  (count + matching doc IDs)

// Autocomplete suggestions
await client.sendCommand(['FT.SUGADD', 'articles', 'sqlite full-text', '10']);
await client.sendCommand(['FT.SUGADD', 'articles', 'sqlite indexing', '5']);
const suggestions = await client.sendCommand(['FT.SUGGET', 'articles', 'sqlite']);
console.log(suggestions);  // → ["sqlite full-text", "sqlite indexing"]
```

### Introspection and admin

```javascript
// Scan keys (cursor-based)
const scanResult = await client.scan(0);
console.log(scanResult);  // → { cursor: 0, keys: [...] }

// Key type
console.log(await client.type('user:1'));  // → "hash"

// Admin commands (via sendCommand)
const sqliteInfo = await client.sendCommand(['SQLITE.INFO']);
const cacheInfo  = await client.sendCommand(['CACHE.INFO']);
const memInfo    = await client.sendCommand(['MEMORY.INFO']);
```

### Data persists across restarts

```javascript
import { createClient } from 'redis';
import { createRESPlite } from 'resplite/embed';

const DB_PATH = './persistent.db';

// --- First session: write data ---
const srv1 = await createRESPlite({ db: DB_PATH });
const c1 = createClient({ socket: { port: srv1.port, host: '127.0.0.1' } });
await c1.connect();
await c1.set('persistent_key', 'survives restart');
await c1.hSet('user:1', { name: 'Alice' });
await c1.quit();
await srv1.close();

// --- Second session: data is still there ---
const srv2 = await createRESPlite({ db: DB_PATH });
const c2 = createClient({ socket: { port: srv2.port, host: '127.0.0.1' } });
await c2.connect();
console.log(await c2.get('persistent_key'));     // → "survives restart"
console.log(await c2.hGet('user:1', 'name'));    // → "Alice"
await c2.quit();
await srv2.close();
```

## Migrating RediSearch indices

If your Redis source uses **RediSearch** (Redis Stack or the `redis/search` module), the best moment to run `migrateSearch()` is after the final KV cutover, once writes to Redis are already frozen. It reads index schemas with `FT.INFO`, creates them in RESPLite, and imports documents by scanning the matching hash keys.

**Programmatic API:**

```javascript
const m = createMigration({ from, to, runId });

const result = await m.migrateSearch({
  onlyIndices:     ['products', 'articles'], // omit to migrate all
  batchDocs:       200,
  maxSuggestions:  10000,
  skipExisting:    true,   // reuse existing destination index if already created
  withSuggestions: true,   // default
  onProgress: (r) => console.log(r.name, r.docsImported, r.warnings),
});
// result.indices: [{ name, created, skipped, docsImported, docsSkipped, docErrors, sugsImported, warnings, error? }]
// result.aborted: true if interrupted by SIGINT/SIGTERM
```

**What gets migrated:**

| RediSearch type | RESPLite | Notes |
|---|---|---|
| TEXT | TEXT | Direct |
| TAG | TEXT | Values preserved; TAG filtering lost |
| NUMERIC | TEXT | Stored as string; numeric range queries not supported |
| GEO, VECTOR, … | skipped | Warning emitted per field |

- Only **HASH**-based indices are supported. JSON (RedisJSON) indices are skipped.
- A `payload` field is added automatically if none of the source fields maps to it.
- Suggestions are imported via `FT.SUGGET "" MAX n WITHSCORES` (no cursor; capped at `maxSuggestions`).
- Graceful shutdown: Ctrl+C finishes the current document, closes SQLite cleanly, and exits with a non-zero code.

## CLI and standalone server reference

If you prefer operating RESPLite from the terminal, or want separate long-running processes, use the commands below.

### Run as a standalone server

```bash
npm start
```

By default the server listens on port **6379** and stores data in `data.db` in the current directory.

```bash
redis-cli -p 6379
> PING
PONG
> SET foo bar
OK
> GET foo
"bar"
```

### Standalone server script (fixed port)

Run this as a persistent background process (`node server.js`). RESPLite will listen on port 6380 and stay up until the process receives SIGINT (Ctrl+C) or SIGTERM; then it closes the server and exits cleanly. If you kill the process (for example, SIGKILL or force quit), all client connections are closed as well.

```javascript
// server.js
import { createRESPlite } from 'resplite/embed';

const srv = await createRESPlite({ port: 6380, db: './data.db' });
console.log(`RESPLite listening on ${srv.host}:${srv.port}`);
```

Then connect from any other script or process:

```bash
redis-cli -p 6380 PING
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `RESPLITE_PORT` | `6379` | Server port |
| `RESPLITE_DB` | `./data.db` | SQLite database file |
| `RESPLITE_PRAGMA_TEMPLATE` | `default` | SQLite PRAGMA preset (see below) |

### PRAGMA templates

| Template | Description | Key settings |
|---|---|---|
| `default` | Balanced durability and speed (recommended) | WAL, synchronous=NORMAL, 20 MB cache |
| `performance` | Maximum throughput, reduced crash safety | WAL, synchronous=OFF, 64 MB cache, 512 MB mmap, exclusive locking |
| `safety` | Crash-safe writes at the cost of speed | WAL, synchronous=FULL, 20 MB cache |
| `minimal` | Only WAL + foreign keys | WAL, foreign_keys=ON |
| `none` | No pragmas applied, pure SQLite defaults | - |

## Benchmark (Redis vs RESPLite)

A typical comparison is **Redis (for example, in Docker)** on one side and **RESPLite locally** on the other. In that setup, RESPLite often shows **better latency** because it avoids Docker networking and runs in the same process or host. The benchmark below uses RESPLite with the **default** PRAGMA template only.

**Example results (Redis vs RESPLite, default pragma, 10k iterations):**

| Suite             | Redis (Docker) | RESPLite (default) |
|-------------------|----------------|--------------------|
| PING              | 9.72K/s        | 37.66K/s           |
| SET+GET           | 4.60K/s        | 11.96K/s           |
| MSET+MGET(10)     | 4.38K/s        | 5.71K/s            |
| INCR              | 9.76K/s        | 19.15K/s           |
| HSET+HGET         | 4.42K/s        | 11.71K/s           |
| HGETALL(50)       | 8.42K/s        | 11.12K/s           |
| HLEN(50)          | 8.88K/s        | 30.72K/s           |
| SADD+SMEMBERS     | 8.33K/s        | 18.19K/s           |
| LPUSH+LRANGE      | 8.29K/s        | 14.78K/s           |
| LREM              | 4.85K/s        | 6.35K/s            |
| ZADD+ZRANGE       | 9.37K/s        | 16.43K/s           |
| ZADD+ZREVRANGE    | 8.22K/s        | 16.82K/s           |
| ZRANK+ZREVRANK    | 4.56K/s        | 13.03K/s           |
| ZREVRANGEBYSCORE  | 8.88K/s        | 16.88K/s           |
| SET+DEL           | 4.75K/s        | 9.99K/s            |
| FT.SEARCH         | 8.39K/s        | 8.81K/s            |

To reproduce the benchmark, run `npm run benchmark -- --template default`. Numbers depend on host and whether Redis is native or in Docker.

## Compatibility matrix

### Supported (v1)

| Category | Commands |
|---|---|
| **Connection** | PING, ECHO, QUIT |
| **Strings** | GET, SET, MGET, MSET, DEL, EXISTS, INCR, DECR, INCRBY, DECRBY, STRLEN |
| **TTL** | EXPIRE, PEXPIRE, TTL, PTTL, PERSIST |
| **Hashes** | HSET, HGET, HMGET, HGETALL, HKEYS, HVALS, HDEL, HEXISTS, HINCRBY |
| **Sets** | SADD, SREM, SMEMBERS, SISMEMBER, SCARD, SPOP, SRANDMEMBER |
| **Lists** | LPUSH, RPUSH, LLEN, LRANGE, LINDEX, LPOP, RPOP, LSET, LTRIM, BLPOP, BRPOP |
| **Sorted sets** | ZADD, ZREM, ZCARD, ZSCORE, ZRANGE, ZREVRANGE, ZRANGEBYSCORE, ZREVRANGEBYSCORE, ZRANK, ZREVRANK, ZCOUNT, ZINCRBY, ZREMRANGEBYRANK, ZREMRANGEBYSCORE |
| **Search (FT.\*)** | FT.CREATE, FT.INFO, FT.ADD, FT.DEL, FT.SEARCH, FT.SUGADD, FT.SUGGET, FT.SUGDEL |
| **Introspection** | TYPE, OBJECT IDLETIME, SCAN, KEYS, RENAME, MONITOR |
| **Admin** | SQLITE.INFO, CACHE.INFO, MEMORY.INFO |

### Not supported (v1)

- Pub/Sub (SUBSCRIBE, PUBLISH, etc.)
- Streams (XADD, XRANGE, etc.)
- Lua (EVAL, EVALSHA)
- Transactions (MULTI, EXEC, WATCH)
- BRPOPLPUSH, BLMOVE (blocking list moves)
- SELECT (multiple logical DBs)

Unsupported commands return: `ERR command not supported yet`.

## Scripts

| Script | Description |
|---|---|
| `npm start` | Run the server |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests |
| `npm run test:integration` | Integration tests |
| `npm run test:contract` | Contract tests (redis client) |
| `npm run test:stress` | Stress tests |
| `npm run benchmark` | Comparative benchmark Redis vs RESPLite |
