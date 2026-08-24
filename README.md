# RESPLite

A RESP server backed by SQLite. Compatible with `redis` clients and `redis-cli`, persistent by default, with zero external daemons and a configurable application cache.

## Overview

RESPLite speaks **RESP** (the Redis Serialization Protocol), so your existing `redis` npm client and `redis-cli` work without changes. The storage layer is **SQLite**: WAL mode, FTS5 for full-text search, and a single `.db` file that survives restarts without snapshots or AOF.

It is not a Redis clone. It covers a practical subset of commands that map naturally to SQLite, suited for single-node workloads where Redis' in-memory latency is not a hard requirement.

- **Zero external services** — just Node.js and a `.db` file.
- **Client-compatible** — works with the official `redis` npm client and `redis-cli` for the supported command subset.
- **Persistent by default** — no snapshots, no AOF, no config.
- **Embeddable** — start the server and connect from the same script.
- **Full-text search** — FT.\* commands via SQLite FTS5.
- **Simple queues** — lists with BLPOP/BRPOP.

### When RESPLite beats Redis in Docker

Building this project surfaced a clear finding: **Redis running inside Docker** on the same host can have **worse latency** than **RESPLite running locally**. Docker's virtual network adds overhead that is avoided when RESPLite runs directly on the host. Results remain workload- and host-dependent; use the benchmark below to check your own deployment.

The strongest use case is **migrating a non-replicated Redis instance that has grown large** (tens of GB). You don't need to manage replicas, AOF, or RDB. Once migrated, you get a single SQLite file and latency that is good enough for most workloads. The built-in migration tooling (see [Migration from Redis](#migration-from-redis)) handles datasets of that size with minimal downtime.

### Benchmark snapshot

Representative results against Redis in Docker on the same host (10k iterations per suite):

| Suite         | Redis (Docker) | RESPLite (default) |
|---------------|----------------|--------------------|
| PING          | 9.32K/s        | 25.14K/s           |
| SET+GET       | 4.75K/s        | 8.92K/s            |
| HSET+HGET     | 4.72K/s        | 9.75K/s            |
| ZADD+ZRANGE   | 8.49K/s        | 11.38K/s           |
| FT.SEARCH     | 8.32K/s        | 7.70K/s            |

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
  cache: {
    maxEntries: 50_000,
    maxBytes: 64 * 1024 * 1024,
    maxHashFields: 256,
    maxHashBytes: 256 * 1024,
    maxSetMembers: 256,
    maxSetBytes: 256 * 1024,
    maxListItems: 256,
    maxListBytes: 256 * 1024,
    maxZsetMembers: 256,
    maxZsetBytes: 256 * 1024,
  },
  commandPolicy: {
    rename: { KEYS: 'SAFE_KEYS' }, // original KEYS is blocked
    disabled: ['MONITOR'],         // blocked as unsupported
  },
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

The hot string and small-collection cache is enabled by default with the limits shown above. SQLite remains the source of truth. Complete hashes, sets, lists, and sorted sets above their per-type limits are not cached; hashes with field TTLs are also excluded. Pass `cache: false` to disable it, or provide only the limits you want to override.

Available hooks:

- `onUnknownCommand`: client sent a command not implemented by RESPLite, such as `EVAL` or `XADD`. Payload includes `argv` (full command line as strings, e.g. `['CLIENT','LIST']`) so you can log exactly what was sent.
- `onCommandError`: a command failed because of wrong type, invalid args, or a handler error. Payload includes `argv` for the full command line.
- `onSocketError`: the connection socket emitted an error, for example `ECONNRESET`.

If you want a tiny in-process smoke test that starts RESPLite and connects with the `redis` client in the same script, see [Minimal embedded example](#minimal-embedded-example) below.

### Command hardening (rename/disable)

You can harden the command surface by renaming sensitive commands and/or disabling them:

```javascript
const srv = await createRESPlite({
  db: './secure.db',
  commandPolicy: {
    rename: {
      KEYS: 'SAFE_KEYS',
      DEL: 'RMDEL',
    },
    disabled: ['MONITOR', 'CLIENT'],
  },
});
```

Behavior:
- `rename`: only the new alias is accepted; the original command name is blocked.
- `disabled`: command is blocked and replies with `ERR command not supported yet`.
- `COMMAND`, `COMMAND COUNT`, and `COMMAND INFO` hide renamed commands entirely (both original names and aliases), and exclude disabled commands.

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
await m.applyDirty({
  concurrency: 32,
  batchKeys: 5000,
  onProgress: (r) => {
    console.log(
      `dirty processed=${r.dirty_keys_processed} pending=${r.dirty_pending} ` +
      `applied=${r.dirty_keys_applied} deleted=${r.dirty_keys_deleted} ` +
      `rate=${r.dirty_keys_per_second.toFixed(1)} keys/s eta=${r.dirty_eta_seconds ?? '—'}s`
    );
  },
});

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

const created = await client.mSetNX({ 'new:1': 'v1', 'new:2': 'v2' });
console.log(created); // → true only when every key was absent

// Key existence and deletion
console.log(await client.exists('k1'));        // → 1
await client.del('k1');
console.log(await client.exists('k1'));        // → 0
```

### Pub/Sub

Use a duplicated client because a RESP2 connection enters subscriber mode after `SUBSCRIBE` or `PSUBSCRIBE`:

```javascript
const subscriber = client.duplicate();
await subscriber.connect();

await subscriber.subscribe('events:orders', (message, channel) => {
  console.log(channel, message);
});

console.log(await client.publish('events:orders', 'order-42')); // → 1

await subscriber.unsubscribe('events:orders');
await subscriber.quit();
```

RESPLite also supports pattern subscriptions through `pSubscribe()` and the `PUBSUB CHANNELS`, `PUBSUB NUMSUB`, and `PUBSUB NUMPAT` introspection commands. Pub/Sub state is ephemeral and belongs to one running RESPLite server instance: messages are not stored in SQLite, offline subscribers miss them, and separate server processes that open the same database do not share subscriptions.

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
console.log(await client.smIsMember('tags', ['node', 'missing'])); // → [true, false]
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

const popped = await client.lmPop(['primary', 'queue'], 'LEFT', { COUNT: 2 });
console.log(popped); // → ["queue", ["b", "c"]] (first non-empty key)
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
console.log(await client.zmScore('leaderboard', ['bob', 'missing'])); // → [250, null]
console.log(await client.zRange('leaderboard', 0, -1));        // → ["alice", "carol", "bob"]
console.log(await client.zRangeByScore('leaderboard', 100, 200)); // → ["alice", "carol"]

const top = await client.zmPop('leaderboard', 'MAX', { COUNT: 2 });
// → { key: "leaderboard", elements: [{ value: "bob", score: 250 }, ...] }
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

### PRAGMA (convention over configuration)

A **template** is applied by default (`default`); you usually don't pass anything. Only pass **overrides** when you need to change specific pragmas.

| Template | Description | Key settings |
|----------|-------------|--------------|
| `default` | Balanced durability and speed (recommended) | WAL, synchronous=NORMAL, 20 MB cache |
| `performance` | Maximum throughput, reduced crash safety | WAL, synchronous=OFF, 64 MB cache, 512 MB mmap, exclusive locking |
| `safety` | Crash-safe writes at the cost of speed | WAL, synchronous=FULL, 20 MB cache |
| `minimal` | Only WAL + foreign keys | WAL, foreign_keys=ON |
| `none` | No pragmas applied, pure SQLite defaults | - |

Override specific pragmas only when needed. Overrides are applied after the template. Example — 1 GB cache:

```javascript
const srv = await createRESPlite({
  db: './data.db',
  pragma: { cache_size: -1024 * 1024 },  // negative = KiB, so 1 GiB
});
```

## Benchmark (Redis vs RESPLite)

A typical comparison is **Redis (for example, in Docker)** on one side and **RESPLite locally** on the other. In that setup, RESPLite can show **better latency** because it avoids Docker networking. The benchmark starts each RESPLite PRAGMA template in an isolated process on the host.

**Example results (Redis vs all RESPLite PRAGMA templates, 10k iterations per suite):**

Throughput is measured in complete suite iterations per second, so a row such as `SET+GET` represents one `SET`/`GET` pair per iteration rather than two separately counted commands.

| Suite | Redis (Docker) | default | performance | safety | minimal |
|---|---:|---:|---:|---:|---:|
| PING | 9.32K/s | 25.14K/s | 25.19K/s | 25.11K/s | 25.30K/s |
| SET+GET | 4.75K/s | 8.92K/s | 10.22K/s | 7.42K/s | 8.87K/s |
| GET (hot) | 9.54K/s | 26.20K/s | 26.17K/s | 26.11K/s | 26.29K/s |
| MSET+MGET(10) | 4.32K/s | 6.79K/s | 7.73K/s | 5.93K/s | 6.79K/s |
| INCR | 10.55K/s | 15.30K/s | 19.95K/s | 11.62K/s | 15.31K/s |
| HSET+HGET | 4.72K/s | 9.75K/s | 11.04K/s | 8.05K/s | 9.78K/s |
| HGET (uncached) | 9.27K/s | 20.00K/s | 21.07K/s | 19.93K/s | 19.98K/s |
| HGET (hot) | 9.07K/s | 15.45K/s | 14.44K/s | 15.82K/s | 16.45K/s |
| HMGET(10) (hot) | 8.33K/s | 20.37K/s | 20.40K/s | 20.39K/s | 20.46K/s |
| HGETALL(50) | 8.49K/s | 11.58K/s | 11.56K/s | 11.59K/s | 11.58K/s |
| HLEN(50) (uncached) | 9.00K/s | 23.40K/s | 24.42K/s | 23.46K/s | 23.46K/s |
| HLEN(50) (hot) | 9.51K/s | 28.68K/s | 28.60K/s | 28.59K/s | 28.93K/s |
| SADD+SMEMBERS | 9.25K/s | 16.35K/s | 16.87K/s | 12.18K/s | 16.28K/s |
| LPUSH+LRANGE | 9.37K/s | 10.38K/s | 11.23K/s | 8.45K/s | 10.36K/s |
| LREM | 4.47K/s | 4.60K/s | 4.93K/s | 3.83K/s | 4.60K/s |
| ZADD+ZRANGE | 8.49K/s | 11.38K/s | 12.49K/s | 9.16K/s | 11.35K/s |
| ZADD+ZREVRANGE | 8.21K/s | 10.85K/s | 12.03K/s | 8.85K/s | 10.85K/s |
| ZRANK+ZREVRANK | 5.13K/s | 9.93K/s | 10.58K/s | 9.93K/s | 9.95K/s |
| ZREVRANGEBYSCORE | 9.49K/s | 14.22K/s | 14.66K/s | 14.20K/s | 14.22K/s |
| SET+DEL | 5.12K/s | 5.62K/s | 6.17K/s | 4.65K/s | 5.62K/s |
| STRLEN | 10.15K/s | 27.53K/s | 27.58K/s | 27.55K/s | 27.73K/s |
| HKEYS(50) | 9.25K/s | 17.51K/s | 17.53K/s | 17.55K/s | 17.60K/s |
| HVALS(50) | 8.99K/s | 15.94K/s | 15.92K/s | 15.95K/s | 15.96K/s |
| LSET | 9.46K/s | 17.83K/s | 19.26K/s | 13.08K/s | 17.83K/s |
| LTRIM | 3.09K/s | 2.92K/s | 3.18K/s | 2.51K/s | 2.92K/s |
| RENAME | 4.62K/s | 5.38K/s | 5.80K/s | 4.46K/s | 5.38K/s |
| ZCOUNT | 9.68K/s | 19.57K/s | 19.54K/s | 19.54K/s | 19.52K/s |
| ZCARD(100) | 9.28K/s | 22.24K/s | 23.32K/s | 22.31K/s | 22.34K/s |
| ZINCRBY | 9.19K/s | 15.59K/s | 16.58K/s | 11.82K/s | 15.42K/s |
| ZREMRANGEBYRANK (pure) | 4.66K/s | 5.20K/s | 5.56K/s | 4.17K/s | 5.05K/s |
| ZREMRANGEBYSCORE (pure) | 4.46K/s | 5.78K/s | 6.21K/s | 4.68K/s | 5.77K/s |
| ZREMRANGEBYRANK (churn) | 2.34K/s | 1.42K/s | 1.51K/s | 1.31K/s | 1.42K/s |
| ZREMRANGEBYSCORE (churn) | 2.32K/s | 1.51K/s | 1.61K/s | 1.38K/s | 1.51K/s |
| SPOP | 9.41K/s | 13.06K/s | 13.90K/s | 10.15K/s | 13.01K/s |
| SRANDMEMBER | 8.95K/s | 14.96K/s | 15.54K/s | 15.04K/s | 14.91K/s |
| HINCRBY | 8.69K/s | 14.08K/s | 15.26K/s | 10.65K/s | 14.08K/s |
| FT.SEARCH | 8.32K/s | 7.70K/s | 7.56K/s | 7.81K/s | 7.87K/s |

In this run, the `default` template was faster than Redis in 33 of 37 suites. Redis remained faster for both churn-heavy sorted-set removal suites, `LTRIM`, and `FT.SEARCH`.

**Memory after the same run:**

Redis `used_memory` and Node.js `heapUsed` describe different allocators and should not be compared as equivalent measurements; RSS is included as the common process-level metric.

| Process | Reported memory | RSS | RSS delta |
|---|---:|---:|---:|
| Redis | `used_memory` 7.16 MB | 26.42 MB | — |
| RESPLite `default` | `heapUsed` 20.40 MB | 103.58 MB | +45.08 MB |
| RESPLite `performance` | `heapUsed` 15.62 MB | 105.67 MB | +44.86 MB |
| RESPLite `safety` | `heapUsed` 14.07 MB | 103.14 MB | +44.66 MB |
| RESPLite `minimal` | `heapUsed` 15.87 MB | 104.30 MB | +45.81 MB |

All four RESPLite variants finished with the application cache enabled and the same counters: 20 entries (3.57 KB), 199,999 hits, 30,006 misses, and an 86.95% hit ratio. The benchmark coordinator process finished at 11.29 MB heap used and 72.08 MB RSS; its heap delta was -11.08 MB.

To reproduce the all-template benchmark, run `npm run benchmark`. Use `npm run benchmark -- --template default` to measure only the default template. Numbers depend on the host, process state, and whether Redis is native or in Docker; compare results from the same run rather than treating this snapshot as a universal performance guarantee.

To compare the cache behavior under the same workload:

```bash
npm run benchmark -- --template default --compare-caches --cache-only
```

This starts three isolated RESPlite processes:

| Variant | RESPlite cache | SQLite cache configuration |
|---|---|---|
| `cache-off` | Disabled | Selected PRAGMA template |
| `cache-default` | 50k entries / 64 MiB | Selected PRAGMA template |
| `cache-production` | 200k entries / 512 MiB | 1 GiB page cache / 2 GiB mmap |

The report includes hot and uncached reads for strings, hashes, sets, lists, and sorted sets, uplift relative to `cache-off`, RSS per process, and `CACHE.INFO` counters. `--cache-only` limits execution to the cache-sensitive workloads; omit it to run the complete benchmark. Add `--resplite-only` when Redis is not available:

```bash
npm run benchmark -- --template default --compare-caches --cache-only --resplite-only
```

### Pub/Sub benchmark

Run the dedicated Pub/Sub comparison with:

```bash
npm run benchmark:pubsub
```

The default matrix measures direct-channel and pattern delivery with 1, 10, and 100 subscribers, plus a zero-subscriber `PUBLISH` baseline, using 64-byte and 1-KiB payloads. Connection setup, subscription acknowledgements, and a 100-publication warmup are excluded from the measured interval. The report includes publications per second, delivered messages per second, and end-to-end delivery latency at p50, p95, and p99.

Use smaller settings for a quick local run:

```bash
npm run benchmark:pubsub -- --iterations 100 --warmup 10 --subscribers 0,1,10 --message-sizes 64
```

Redis must be listening on port 6379 unless `--redis-port` is provided. To measure only RESPLite, use `--resplite-only`. The benchmark starts one isolated RESPLite process with an in-memory database because Pub/Sub messages and subscriptions are ephemeral; select its PRAGMA template with `--template` if needed.

## Compatibility matrix

### Supported (v1)

| Category | Commands |
|---|---|
| **Connection** | PING, ECHO, QUIT |
| **Strings** | GET, SET, MGET, MSET, MSETNX, DEL, EXISTS, INCR, DECR, INCRBY, DECRBY, STRLEN |
| **TTL** | EXPIRE, PEXPIRE, TTL, PTTL, PERSIST |
| **Hashes** | HSET, HGET, HMGET, HGETALL, HKEYS, HVALS, HDEL, HEXISTS, HINCRBY, HEXPIRE, HTTL, HPERSIST |
| **Sets** | SADD, SREM, SMEMBERS, SISMEMBER, SMISMEMBER, SCARD, SPOP, SRANDMEMBER |
| **Lists** | LPUSH, RPUSH, LLEN, LRANGE, LINDEX, LPOP, RPOP, LMPOP, LSET, LTRIM, BLPOP, BRPOP |
| **Sorted sets** | ZADD, ZREM, ZCARD, ZSCORE, ZMSCORE, ZMPOP, ZRANGE, ZREVRANGE, ZRANGEBYSCORE, ZREVRANGEBYSCORE, ZRANK, ZREVRANK, ZCOUNT, ZINCRBY, ZREMRANGEBYRANK, ZREMRANGEBYSCORE |
| **Search (FT.\*)** | FT.CREATE, FT.INFO, FT.ADD, FT.DEL, FT.GET, FT.SEARCH, FT.SUGADD, FT.SUGGET, FT.SUGDEL |
| **Pub/Sub** | PUBLISH, SUBSCRIBE, UNSUBSCRIBE, PSUBSCRIBE, PUNSUBSCRIBE, PUBSUB CHANNELS, PUBSUB NUMSUB, PUBSUB NUMPAT |
| **Introspection** | TYPE, OBJECT IDLETIME, SCAN, KEYS, RENAME, MONITOR |
| **Admin** | SQLITE.INFO, CACHE.INFO, MEMORY.INFO |

### Not supported (v1)

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
