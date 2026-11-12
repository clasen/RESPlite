# RESPLite

A RESP server backed by SQLite. Compatible with `redis` clients and `redis-cli`, persistent by default, with zero external daemons and a configurable application cache.

## Overview

RESPLite speaks **RESP** (the Redis Serialization Protocol), so your existing `redis` npm client and `redis-cli` work without changes. The storage layer is **SQLite**: WAL mode, FTS5 for full-text search, and a single `.db` file that survives restarts without snapshots or AOF.

It is not a Redis clone. It covers a practical subset of commands that map naturally to SQLite, suited for single-node workloads where Redis' in-memory latency is not a hard requirement.

- **Zero external services** — just Node.js or Bun and a `.db` file.
- **Client-compatible** — works with the official `redis` npm client and `redis-cli` for the supported command subset.
- **Persistent by default** — no snapshots, no AOF, no config.
- **Embeddable** — start the server and connect from the same script.
- **Full-text search** — FT.\* commands via SQLite FTS5.
- **Simple queues** — lists with BLPOP/BRPOP.

### When RESPLite beats Redis in Docker

Building this project surfaced a clear finding: **Redis running inside Docker** on the same host can have **worse latency** than **RESPLite running locally**. Docker's virtual network adds overhead that is avoided when RESPLite runs directly on the host. Results remain workload- and host-dependent; use the benchmark below to check your own deployment.

The strongest use case is **migrating a non-replicated Redis instance that has grown large** (tens of GB). You don't need to manage replicas, AOF, or RDB. Once migrated, you get a single SQLite file and latency that is good enough for most workloads. The built-in migration tooling (see [Migration from Redis](#migration-from-redis)) handles datasets of that size with minimal downtime.

### Benchmark snapshot

Representative results against a native Redis 8.4 on the same host (10k iterations per suite). RESPLite leads on most reads; Redis keeps the lead on write-heavy multi-command suites:

| Suite         | Redis (native) | RESPLite (default) |
|---------------|----------------|--------------------|
| PING          | 14.31K/s       | 25.74K/s           |
| SET+GET       | 7.26K/s        | 11.09K/s           |
| HSET+HGET     | 7.32K/s        | 11.43K/s           |
| ZADD+ZRANGE   | 12.99K/s       | 11.53K/s           |
| LPUSH+LRANGE  | 13.14K/s       | 10.06K/s           |

The full benchmark table is available later in [Benchmark](#benchmark-redis-vs-resplite).

## Install

```bash
npm install resplite
```

Requires Node.js 22.18+ or Bun. RESPLite uses the runtime's built-in `node:sqlite` module, so there is no native dependency to compile. On Node.js 22 the module still prints an `ExperimentalWarning` on first use.

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
  search: {
    minPrefix: 3,     // FT.SEARCH rejects shorter prefix terms such as "ab*"
    maxResults: 10_000,
    timeoutMs: 500,   // 0 disables the default budget
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

Use one RESPlite server per database in production. Independent processes do not invalidate each other's hot caches. Disable caching if another process accesses the same database; this alone does not guarantee cross-process atomicity for every command.

Available hooks:

- `onUnknownCommand`: client sent an unsupported command, such as `XADD` or `EVAL` on an instance without scripting. Payload includes `argv` (full command line as strings, e.g. `['CLIENT','LIST']`) so you can log exactly what was sent.
- `onCommandError`: a command failed because of wrong type, invalid args, or a handler error. Payload includes `argv` for the full command line.
- `onSocketError`: the connection socket emitted an error, for example `ECONNRESET`.

If you want a tiny in-process smoke test that starts RESPLite and connects with the `redis` client in the same script, see [Minimal embedded example](#minimal-embedded-example) below.

### Optional Lua scripting

#### Fengari adapter (trusted scripts)

Start with Fengari for trusted application scripts. `resplite/scripting` exports `createFengariScripting(fengari, options)`, a stable adapter for application-controlled, trusted scripts, tested with `fengari@0.1.5`. Only enable it where callers allowed to execute or load scripts are trusted. Install Fengari in the consuming application; RESPLite does not import or install it at runtime. Both Lua libraries are development dependencies of RESPLite for testing only.

```bash
npm install fengari@0.1.5
```

```javascript
import fengari from 'fengari';
import { createRESPlite } from 'resplite/embed';
import { createFengariScripting } from 'resplite/scripting';

const srv = await createRESPlite({
  db: './data.db',
  scripting: createFengariScripting(fengari),
});
```

Fengari needs no asynchronous module initialization. The commands, source cache, RESP2 conversions, command policy, atomic execution and lifecycle described below apply to both adapters.

**The supported scope has these resource and compatibility limits:**

- Fengari implements Lua 5.3 with 32-bit integers and double-precision floats. Integer arithmetic can wrap at 32 bits; it is not interchangeable with Lua 5.4 or Redis Lua 5.1 for all scripts.
- Memory belongs to the JavaScript garbage collector. There is no per-state memory cap; passing `maxMemoryBytes` is rejected explicitly.
- Instruction hooks interrupt yieldable Lua loops. In native callbacks such as `table.sort` comparators, interruption raises a catchable Lua error. A script that repeatedly catches it can keep running past `timeoutMs`; commands after the deadline are refused, but execution is not guaranteed to terminate. Native operations and synchronous SQLite calls also cannot be preempted.

#### Shared scripting behavior

This enables `EVAL script numkeys [keys...] [args...]`, `EVALSHA sha numkeys [keys...] [args...]`, `SCRIPT LOAD`, `SCRIPT EXISTS`, and `SCRIPT FLUSH [SYNC]` for that instance. Without the plugin, these commands remain unsupported and are absent from `COMMAND`. `SCRIPT FLUSH ASYNC` is not supported.

Scripts receive `KEYS`, `ARGV`, `redis.call`, `redis.pcall`, `redis.error_reply`, and `redis.status_reply`. `redis.call` raises command errors; `redis.pcall` returns `{err=message}`. Missing values become Lua `false`; returned `false`/`nil` becomes RESP null, `true` becomes `1`, and numeric replies are truncated to integers. Numeric replies outside JavaScript's safe integer range are rejected. Arrays stop at the first Lua `nil`; nested status/error replies are supported. Keys, arguments, source and bulk replies preserve arbitrary bytes, including NUL and invalid UTF-8. Error/status messages are text with line breaks replaced by spaces.

Available commands inside scripts are the implemented string, hash, set, non-blocking list, sorted-set, key and TTL commands, plus `PING` and `ECHO`. Administrative commands, Pub/Sub, `FT.*`, blocking commands and nested scripting are rejected. Existing command rename/disable rules also apply inside scripts. Hooks and `MONITOR` report the outer invocation, not each internal command.

Each execution has a fresh Lua state. Basic functions (`assert`, `error`, `ipairs`, `next`, `pairs`, `pcall`, `select`, `tonumber`, `tostring`, `type`, `xpcall`) and the `string`, `table`, and `math` libraries are available, except `string.dump`. Filesystem, OS, JavaScript, module loading, metatable access, coroutines and external bytecode are not exposed.

`cjson.encode`, `cjson.decode` and `cjson.null` follow Redis' default `cjson` behavior: `/` is escaped, numbers use 14 significant digits, empty tables encode as `{}`, arrays with holes encode `null` unless excessively sparse, and nesting is limited to 1,000 levels. JSON `null` decodes to `cjson.null`, which a script reply converts to RESP null. Strings are bytes in both directions; `\u` escapes decode to UTF-8. Decoding accepts standard JSON numbers only and returns Lua integers for integral values within the runtime's integer range. Other `cjson` functions and settings are not available.

The trusted internal bootstrap is compiled once per supplied Lua module and reused as bytecode. User scripts remain text-only and are compiled for each execution; `EVALSHA` reuses the cached SHA-1 without hashing the source again.

Scripts execute synchronously: other clients of the same server cannot interleave commands, TTL checks use the script's starting time, and blocked list consumers wake after execution finishes. **Errors and timeouts preserve writes already performed.** Atomic execution does not imply rollback or isolation from other processes independently opening the SQLite file.

`EVAL` and `SCRIPT LOAD` cache successfully compiled source by SHA-1; execution errors do not remove it. The cache is per plugin, uses LRU eviction, and disappears on flush, close or restart. `EVALSHA` avoids transferring source but still compiles it in a fresh state; a missing or evicted hash returns `NOSCRIPT`. `SCRIPT EXISTS` does not refresh LRU order.

Limits are centralized in `src/scripting/config.js`. Override only the required values in the second argument to `createFengariScripting(fengari, options)` or `createWasmoonScripting(luaModule, options)`:

| Option | Default | Applies to |
| --- | --- | --- |
| `timeoutMs` | 1,000 | Execution budget, checked during Lua instructions and between commands |
| `maxMemoryBytes` | 16 MiB | Lua state allocations (Wasmoon only; rejected by Fengari) |
| `maxScriptBytes` | 256 KiB | Individual source size |
| `maxCachedScripts` | 256 | Cached source count |
| `maxCacheBytes` | 4 MiB | Total cached source bytes |

All limits must be positive safe integers. A script larger than either source/cache byte limit is rejected before execution. Returned tables are limited to 128 levels and cycles are rejected. With Wasmoon, timeouts cannot be suppressed by Lua `pcall`/`xpcall`; Fengari has the timeout limitations described above. Neither adapter can interrupt a synchronous SQLite operation or a native Lua operation already running. Wasmoon memory limits do not cap the Node process, command results in JavaScript, or the entire shared WebAssembly module.

`createRESPlite()` and synchronous `startServer()` both accept the prepared `scripting` option. They own the plugin and close it on shutdown or startup failure. One plugin can belong to only one server; to use the same Lua module in a group, create a separate plugin for each instance. Closed plugins cannot be reused.

For manual wiring, pass `{ pubSub, scripting }` as the fifth argument to `handleConnection()`, reuse the same engine/plugin for that server, and call `scripting.close()` during teardown. Closing is idempotent; the injected Lua module remains owned by the application. Plain CLI startup does not load a plugin automatically; use a JavaScript launcher to prepare one.

The adapters provide Lua 5.3 (Fengari) or Lua 5.4 (Wasmoon) scripting subsets, not full compatibility with Redis Lua 5.1. `cmsgpack`, `bit`, `SCRIPT KILL`, `BUSY`, Redis Functions, read-only scripting variants and persistent scripts are not implemented.

#### Wasmoon adapter (resource limits)

Use Wasmoon when a per-state memory cap and a protected-call-resistant timeout are required.

Install Wasmoon in the application that hosts RESPLite. RESPLite does not install or import it at runtime; the adapter is tested with `wasmoon@1.16.0` (Lua 5.4).

```bash
npm install wasmoon@1.16.0
```

```javascript
import { LuaFactory } from 'wasmoon';
import { createRESPlite } from 'resplite/embed';
import { createWasmoonScripting } from 'resplite/scripting';

const luaModule = await new LuaFactory().getLuaModule();
const srv = await createRESPlite({
  db: './data.db',
  scripting: createWasmoonScripting(luaModule),
});
```

#### Scripting benchmark

Fengari performance measurements should run in a child process with an external watchdog; they do not establish equivalent compatibility or resource limits.

From a development checkout, run the comparison against Redis on `127.0.0.1:6379` with:

```bash
BENCH_OUTPUT=/tmp/resplite-scripting-benchmark.json node scripts/benchmark-scripting.js
```

The benchmark starts separate Wasmoon and Fengari servers with temporary SQLite WAL databases, rotates target order over three rounds, and measures one and eight clients. It uses unique Redis keys and deletes them afterward; it does not flush Redis. Counts, warmup and watchdog duration are defined in the benchmark's `config` object.

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

`resplite/migration` connects to the source with the `redis` client, an optional peer dependency. Install it in the application that runs the migration:

```bash
npm install redis@4
```

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

### Multiple embedded instances

Use `createRESPliteGroup` when one process owns two or more independent RESPLite servers:

```javascript
import { createRESPliteGroup } from 'resplite/embed';

const group = await createRESPliteGroup({
  main: {
    port: 6380,
    db: './main.db',
  },
  volatile: {
    port: 6379,
    db: ':memory:',
  },
});

console.log(group.servers.main.port);
await group.close();
```

The group starts instances in declaration order, rolls back those already running if a later start fails, and owns one `SIGTERM`/`SIGINT` handler pair. `group.close()` is idempotent and attempts to close every instance before reporting an `AggregateError`. Pass `{ gracefulShutdown: false }` as the second argument when the application owns process shutdown. Persistent instances in the same group must use different SQLite files.

The group coordinates lifecycle only. Its instances do not share data, cache, or Pub/Sub subscriptions.

### Strings, TTL, and key operations

```javascript
// SET with expiration
await client.set('session:abc', JSON.stringify({ user: 'alice' }));
await client.expire('session:abc', 3600);      // expire in 1 hour
console.log(await client.ttl('session:abc'));  // → 3600 (approx)

// Set only when absent, with a TTL (locks and singletons)
console.log(await client.set('lock:report', 'worker-1', { NX: true, EX: 30 }));  // → "OK", or null when taken
console.log(await client.set('lock:report', 'worker-2', { XX: true, GET: true })); // → "worker-1"

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

Subscriber connections buffer outgoing messages in order while the socket is congested and resume writing on `drain`. Pending output is limited to 32 MiB per connection, including both the application queue and the socket buffer. Exceeding this limit disconnects that subscriber and discards its pending messages; other subscribers continue receiving. Embedded servers report the error code `PUBSUB_OUTPUT_LIMIT` through `hooks.onSocketError`.

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

RESPLite runs one command at a time, so `FT.SEARCH` is bounded to keep a broad query from stalling every client. The `search` option of `createRESPlite()` and `startServer()` sets the guards, modeled on RediSearch:

| Option | Default | Effect |
|---|---|---|
| `minPrefix` | `3` | Prefix terms need at least this many characters before `*` (RediSearch `MINPREFIX` defaults to 2). `"ab*"` returns an error instead of making SQLite merge the postings of every term that starts with `ab`. |
| `maxResults` | `10000` | Matches read per query. The reply's total stops at this value, and results are ranked by BM25 among the matches read, so a capped query ranks only its first `maxResults` matches in index order. |
| `timeoutMs` | `500` | Time budget per query; `0` disables it. `FT.SEARCH ... TIMEOUT <ms>` overrides it per query, and `TIMEOUT 0` disables it for that query. A query over budget fails with `ERR Timeout limit was reached`. |

`node:sqlite` cannot interrupt a running statement, so the budget is checked between matched rows. The work SQLite does before returning the first match is bounded by `minPrefix`, not by the budget.

`FT.INFO` reads `num_docs`, `fts_rows` and `num_suggestions` from in-memory counters kept in step with every write, so it costs the same on any index size. They are counted once per index when the server starts.

### Introspection and admin

```javascript
// Scan keys (cursor-based)
const scanResult = await client.scan(0);
console.log(scanResult);  // → { cursor: 0, keys: [...] }

// Key type
console.log(await client.type('user:1'));  // → "hash"

// Redis-style server report and per-key stored size
const info  = await client.info();             // all sections
const stats = await client.info('keyspace');   // one section
const bytes = await client.memoryUsage('user:1');

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

With Bun, run the same entry point directly: `bun src/index.js`.

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
| `minimal` | Only WAL, sync mode and foreign keys | WAL, synchronous=NORMAL, foreign_keys=ON |
| `none` | No pragmas applied, pure SQLite defaults | - |

Override specific pragmas only when needed. Overrides are applied after the template. Example — 1 GB cache:

```javascript
const srv = await createRESPlite({
  db: './data.db',
  pragma: { cache_size: -1024 * 1024 },  // negative = KiB, so 1 GiB
});
```

### Pipelining

Commands that arrive together in one pipelined read (for example, concurrent calls from the `redis` client in the same tick) run in a single SQLite write transaction, and their replies are sent once it commits. This removes most of the per-command commit cost. Each command still succeeds or fails on its own, and replies keep their order. `QUIT`, `MONITOR`, blocking and subscription commands are never batched.

A batch holds the database write lock until it commits. If several processes write to the same `.db` file, they wait for each other's batches.

## Benchmark (Redis vs RESPLite)

The comparison below runs Redis natively on the same host as RESPLite. Redis in Docker adds network overhead and widens RESPLite's lead, so compare against the setup you deploy. The benchmark starts each RESPLite PRAGMA template in an isolated process on the host.

**Example results (native Redis 8.4 vs all RESPLite PRAGMA templates on Node.js 22, 10k iterations per suite):**

Throughput is measured in complete suite iterations per second, so a row such as `SET+GET` represents one `SET`/`GET` pair per iteration rather than two separately counted commands.

| Suite | Redis (native) | default | performance | safety | minimal |
|---|---:|---:|---:|---:|---:|
| PING | 14.31K/s | 25.74K/s | 25.78K/s | 26.02K/s | 25.66K/s |
| SET+GET | 7.26K/s | 11.09K/s | 12.78K/s | 9.04K/s | 11.10K/s |
| GET (hot) | 14.85K/s | 26.64K/s | 26.61K/s | 26.99K/s | 26.48K/s |
| MSET+MGET(10) | 6.77K/s | 7.39K/s | 8.43K/s | 6.41K/s | 7.37K/s |
| INCR | 15.00K/s | 14.38K/s | 18.49K/s | 11.13K/s | 14.44K/s |
| HSET+HGET | 7.32K/s | 11.43K/s | 12.66K/s | 9.38K/s | 11.40K/s |
| HGET (uncached) | 14.54K/s | 22.32K/s | 22.87K/s | 22.41K/s | 22.27K/s |
| HGET (hot) | 14.78K/s | 26.13K/s | 26.17K/s | 26.28K/s | 25.95K/s |
| HMGET(10) (hot) | 14.15K/s | 20.78K/s | 20.82K/s | 20.90K/s | 20.76K/s |
| HGETALL(50) | 12.32K/s | 11.50K/s | 11.49K/s | 11.51K/s | 11.47K/s |
| HLEN(50) (uncached) | 15.06K/s | 23.32K/s | 24.13K/s | 23.38K/s | 23.26K/s |
| HLEN(50) (hot) | 14.83K/s | 26.96K/s | 27.00K/s | 27.23K/s | 26.82K/s |
| SMEMBERS(50) (hot) | 13.25K/s | 16.13K/s | 16.13K/s | 16.19K/s | 16.09K/s |
| SISMEMBER(50) (hot) | 14.91K/s | 26.73K/s | 26.73K/s | 27.06K/s | 26.66K/s |
| LRANGE(20/50) (hot) | 13.85K/s | 19.83K/s | 19.83K/s | 19.90K/s | 19.76K/s |
| LINDEX(50) (hot) | 14.72K/s | 25.67K/s | 25.68K/s | 25.98K/s | 25.56K/s |
| ZRANGE(20/100) (hot) | 14.06K/s | 20.26K/s | 20.22K/s | 20.36K/s | 20.19K/s |
| ZSCORE(100) (hot) | 14.39K/s | 26.49K/s | 26.48K/s | 26.69K/s | 26.33K/s |
| SADD+SMEMBERS | 13.07K/s | 17.83K/s | 18.53K/s | 12.54K/s | 17.81K/s |
| LPUSH+LRANGE | 13.14K/s | 10.06K/s | 12.44K/s | 9.28K/s | 11.51K/s |
| LREM | 7.21K/s | 5.24K/s | 5.64K/s | 4.30K/s | 5.24K/s |
| ZADD+ZRANGE | 12.99K/s | 11.53K/s | 14.19K/s | 9.93K/s | 12.89K/s |
| ZADD+ZREVRANGE | 13.05K/s | 12.43K/s | 14.85K/s | 10.55K/s | 13.62K/s |
| ZRANK+ZREVRANK | 7.22K/s | 10.19K/s | 10.96K/s | 10.32K/s | 10.14K/s |
| ZREVRANGEBYSCORE | 13.79K/s | 14.73K/s | 15.27K/s | 14.78K/s | 14.65K/s |
| SET+DEL | 7.42K/s | 6.22K/s | 6.75K/s | 4.96K/s | 6.26K/s |
| STRLEN | 14.99K/s | 27.72K/s | 27.72K/s | 28.12K/s | 27.62K/s |
| HKEYS(50) | 13.52K/s | 15.91K/s | 15.93K/s | 16.00K/s | 15.88K/s |
| HVALS(50) | 13.51K/s | 15.70K/s | 15.69K/s | 15.72K/s | 15.61K/s |
| LSET | 14.78K/s | 20.01K/s | 21.83K/s | 10.92K/s | 20.07K/s |
| LTRIM | 4.80K/s | 3.15K/s | 3.42K/s | 2.65K/s | 3.15K/s |
| RENAME | 7.44K/s | 6.13K/s | 6.64K/s | 4.93K/s | 6.14K/s |
| ZCOUNT | 14.50K/s | 22.29K/s | 23.53K/s | 22.42K/s | 22.18K/s |
| ZCARD(100) | 15.08K/s | 23.45K/s | 24.69K/s | 23.60K/s | 23.30K/s |
| ZINCRBY | 14.33K/s | 17.10K/s | 18.58K/s | 12.23K/s | 17.15K/s |
| ZREMRANGEBYRANK (pure) | 6.90K/s | 5.62K/s | 6.45K/s | 4.51K/s | 5.57K/s |
| ZREMRANGEBYSCORE (pure) | 6.86K/s | 6.71K/s | 6.84K/s | 5.10K/s | 6.69K/s |
| ZREMRANGEBYRANK (churn) | 3.13K/s | 1.53K/s | 1.63K/s | 1.40K/s | 1.53K/s |
| ZREMRANGEBYSCORE (churn) | 3.13K/s | 1.63K/s | 1.73K/s | 1.48K/s | 1.62K/s |
| SPOP | 13.92K/s | 15.27K/s | 16.45K/s | 11.74K/s | 15.25K/s |
| SRANDMEMBER | 14.86K/s | 17.22K/s | 17.65K/s | 17.24K/s | 17.17K/s |
| HINCRBY | 14.66K/s | 19.56K/s | 20.97K/s | 13.52K/s | 19.57K/s |
| FT.SEARCH | 9.16K/s* | 7.11K/s | 8.22K/s | 7.17K/s | 7.13K/s |

\* The native Redis build does not include the search module, so the `FT.SEARCH` Redis figure comes from a separate run against Redis Stack 7.4 in Docker on the same host.

In this run, the `default` template was faster than Redis in 29 of 43 suites. Redis stayed ahead on `HGETALL(50)`, `FT.SEARCH`, and write-heavy multi-command suites: `INCR`, `LPUSH+LRANGE`, `LREM`, `ZADD+ZRANGE`, `ZADD+ZREVRANGE`, `SET+DEL`, `LTRIM`, `RENAME`, and the sorted-set range removals.

**Memory after the same run:**

Redis `used_memory` and Node.js `heapUsed` describe different allocators and should not be compared as equivalent measurements; RSS is included as the common process-level metric.

| Process | Reported memory | RSS | RSS delta |
|---|---:|---:|---:|
| Redis | `used_memory` 4.44 MB | 7.91 MB | — |
| RESPLite `default` | `heapUsed` 12.77 MB | 136.84 MB | +44.33 MB |
| RESPLite `performance` | `heapUsed` 12.44 MB | 148.34 MB | +48.00 MB |
| RESPLite `safety` | `heapUsed` 21.47 MB | 137.70 MB | +40.11 MB |
| RESPLite `minimal` | `heapUsed` 21.89 MB | 151.38 MB | +55.45 MB |

All four RESPLite variants finished with the application cache enabled and the same counters: 26 entries (8.46 KB), 259,999 hits, 94,012 misses, and a 73.44% hit ratio. The benchmark coordinator process finished at 32.73 MB heap used and 132.80 MB RSS; its heap delta was -0.09 MB.

To reproduce the all-template benchmark, run `npm run benchmark`. Use `npm run benchmark -- --template default` to measure only the default template. Numbers depend on the host, process state, and whether Redis is native or in Docker; compare results from the same run rather than treating this snapshot as a universal performance guarantee.

To benchmark only the hash commands added after the original snapshot:

```bash
npm run benchmark:hash
```

This focused run compares `HSETNX` (successful insert and existing-field no-op), `HMSET`, `HINCRBYFLOAT`, `HSTRLEN`, `HSCAN`, `HRANDFIELD`, and the millisecond/absolute hash-field expiration commands against Redis. `HSETNX (insert+reset)` is a two-command workload because each successful insertion is preceded by `HDEL`; every other row is one measured command per iteration. Use `--iterations`, `--redis-port`, `--resplite-port`, or `--resplite-only` as with the main benchmark.

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
| **Strings** | GET, SET, SETNX, MGET, MSET, MSETNX, DEL, UNLINK, EXISTS, INCR, DECR, INCRBY, DECRBY, STRLEN |
| **TTL** | EXPIRE, PEXPIRE, TTL, PTTL, PERSIST |
| **Hashes** | HSET, HSETNX, HMSET, HGET, HMGET, HGETALL, HKEYS, HVALS, HDEL, HEXISTS, HLEN, HSTRLEN, HINCRBY, HINCRBYFLOAT, HSCAN, HRANDFIELD, HEXPIRE, HPEXPIRE, HEXPIREAT, HPEXPIREAT, HTTL, HPTTL, HEXPIRETIME, HPEXPIRETIME, HPERSIST |
| **Sets** | SADD, SREM, SMEMBERS, SISMEMBER, SMISMEMBER, SCARD, SPOP, SRANDMEMBER |
| **Lists** | LPUSH, RPUSH, LLEN, LRANGE, LINDEX, LPOP, RPOP, LMPOP, LSET, LTRIM, BLPOP, BRPOP |
| **Sorted sets** | ZADD, ZREM, ZCARD, ZSCORE, ZMSCORE, ZMPOP, ZRANGE, ZREVRANGE, ZRANGEBYSCORE, ZREVRANGEBYSCORE, ZRANK, ZREVRANK, ZCOUNT, ZINCRBY, ZREMRANGEBYRANK, ZREMRANGEBYSCORE |
| **Search (FT.\*)** | FT.CREATE, FT.INFO, FT.ADD, FT.DEL, FT.GET, FT.SEARCH, FT.SUGADD, FT.SUGGET, FT.SUGDEL |
| **Pub/Sub** | PUBLISH, SUBSCRIBE, UNSUBSCRIBE, PSUBSCRIBE, PUNSUBSCRIBE, PUBSUB CHANNELS, PUBSUB NUMSUB, PUBSUB NUMPAT |
| **Introspection** | TYPE, OBJECT IDLETIME, SCAN, KEYS, RENAME, MONITOR |
| **Admin** | INFO, MEMORY USAGE, MEMORY STATS, MEMORY PURGE, MEMORY HELP, DBSIZE, FLUSHDB, FLUSHALL, SQLITE.INFO, CACHE.INFO, MEMORY.INFO |

`INFO [section ...]` returns the Redis text format with the `server`, `clients`, `memory`, `persistence`, `stats` and `keyspace` sections, plus RESPlite's `sqlite` and `cache` sections. Memory figures come from the Node.js process; `redis_version` reports the Redis release whose semantics RESPlite follows and `resplite_version` the package version. `MEMORY USAGE` reports the stored bytes of the key name and its payload in SQLite (exact, so `SAMPLES` is accepted but ignored), not Redis allocator overhead. `MEMORY PURGE` is a no-op.

RESPlite has one logical database, so `FLUSHDB` and `FLUSHALL` have the same effect. Both accept `SYNC` and `ASYNC` for client compatibility, but SQLite completes either form synchronously. A flush removes the keyspace and all `FT.*` indices, documents, and suggestions; internal migration bookkeeping is preserved.

`DBSIZE` and the `keys` figure of `INFO keyspace` read an in-memory key counter kept in step with every write, including expiry, renames, flushes and migration imports; rolled-back writes are undone. Expired keys and hashes whose fields have all expired are not counted, as before; only those still waiting for lazy or active expiry are counted at read time, so the cost follows the expiry backlog rather than the database size. Keys are counted once when the server starts (about 30 ms per million keys on a warm cache), and counted again on the next read after another process commits to the same database.

`HMSET` is retained as a legacy compatibility alias and returns `OK`; new applications should use multi-field `HSET`. Hash field expiration follows Redis 7.4 semantics: `HSET` clears the affected field TTL, while `HINCRBY` and `HINCRBYFLOAT` preserve it.

`SET` follows the Redis 7 option set: `[NX | XX] [GET] [EX seconds | PX milliseconds | EXAT unix-time-seconds | PXAT unix-time-milliseconds | KEEPTTL]`, in any order and case-insensitive. A skipped write replies nil, `GET` replies with the previous value, and `KEEPTTL` preserves the existing expiration while every other form clears it. `SETNX` is retained as the legacy alias of `SET key value NX`. Like Redis, `SET`, `SETEX` and `MSET` replace a key of any type, while reads and numeric mutations (`GET`, `INCR`, `HGET`, ...) still report `WRONGTYPE` on a mismatched key.

### Not supported (v1)

- Streams (XADD, XRANGE, etc.)
- Full Redis Lua 5.1 compatibility (optional scripting is available through Fengari (Lua 5.3) or Wasmoon (Lua 5.4))
- Transactions (MULTI, EXEC, WATCH)
- BRPOPLPUSH, BLMOVE (blocking list moves)
- SELECT (multiple logical DBs)

Unsupported commands return: `ERR command not supported yet`.

## Scripts

RESPLite is written in TypeScript. `npm run build` compiles `src/` to `dist/`, which is what the package publishes. Development scripts run the TypeScript sources directly.

| Script | Description |
|---|---|
| `npm start` | Run the server |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests |
| `npm run test:integration` | Integration tests |
| `npm run test:contract` | Contract tests (redis client) |
| `npm run test:stress` | Stress tests |
| `npm run test:bun` | All tests under Bun |
| `npm run benchmark` | Comparative benchmark Redis vs RESPLite |
