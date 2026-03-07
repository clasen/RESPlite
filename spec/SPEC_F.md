# Appendix F: Migration with Dirty Key Registry (Keyspace Notifications)

## F.1 Goals

* Migrate a large Redis dataset (example: ~30 GB) into RespLite with minimal downtime.
* Perform the bulk of the migration online while the application continues using Redis.
* Capture keys modified during the bulk copy into a **persistent Dirty Key Registry**.
* During a short cutover window, apply a **delta migration** from the Dirty Key Registry to reach consistency.
* Provide progress reporting, resumability, throttling controls, and verification.

## F.2 Non-Goals (v1)

* Perfect change-data-capture guarantees equivalent to replication logs.
* Distributed migration across multiple import workers with strict ordering semantics.
* Full fidelity for unsupported Redis data types (streams, modules, Lua scripts, etc.).
* **Search indices (FT.\*):** Keyspace migration (`bulk` / `apply-dirty`) copies only the Redis KV data (strings, hashes, sets, lists, zsets). RediSearch index schemas and documents are migrated separately via the `migrate-search` step (§F.10).

---

# F.3 Overview

This migration strategy uses two cooperating processes:

1. **Bulk Importer**

   * Scans the entire keyspace with `SCAN`.
   * Copies supported key types and TTLs into the RespLite SQLite database.
   * Checkpoints progress frequently.

2. **Dirty Key Tracker**

   * Subscribes to Redis Keyspace Notifications.
   * Records keys that are modified (and keys that are deleted or expire) into a persistent registry in SQLite.
   * Enables the delta migration to focus only on changed keys.

After bulk completes, you perform a controlled **cutover**:

* Temporarily freeze writes to Redis (application maintenance window).
* Apply the delta migration by reimporting dirty keys (and deleting keys that were removed in Redis).
* Switch clients to RespLite.

---

# F.4 Redis Requirements

## F.4.1 Keyspace Notifications

Redis must be configured to emit keyspace and/or keyevent notifications. The exact flags depend on your required coverage.

### Recommended minimal event coverage for delta migration

You must capture:

* Key modifications (writes) for all supported types
* TTL changes (EXPIRE/PEXPIRE/PERSIST)
* Deletions
* Expiration events

### Recommended `notify-keyspace-events` flags (pragmatic v1)

A practical baseline is:

* `K` (Keyspace events) or `E` (Keyevent events)
* `g` (generic commands like DEL, EXPIRE)
* `x` (expired events)
* plus type-specific sets as needed:

  * `s` (string)
  * `h` (hash)
  * `l` (list)
  * `z` (zset)
  * `t` (set)

If you need the broadest coverage, use “all” (often `AKE`-style in some docs), but configuration specifics vary by Redis version and operational policy. The migration tool should:

* detect whether notifications are enabled
* refuse or warn if they are not enabled

## F.4.2 Permissions

The tracking client needs:

* `PSUBSCRIBE` capability to the keyevent/keyspace channels
* Ability to read keys during delta verification (optional)
  The bulk importer needs:
* `SCAN`, `TYPE`, read commands per type, and `PTTL`

---

# F.5 Dirty Key Registry (SQLite)

The registry lives in the destination SQLite database so it is persistent and resumable.

## F.5.1 Schema

### Migration run registry

```sql id="e1f4j9"
CREATE TABLE migration_runs (
  run_id TEXT PRIMARY KEY,
  source_uri TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,               -- running|paused|completed|failed|aborted

  scan_cursor TEXT NOT NULL DEFAULT "0",
  scan_count_hint INTEGER NOT NULL DEFAULT 1000,

  scanned_keys INTEGER NOT NULL DEFAULT 0,
  migrated_keys INTEGER NOT NULL DEFAULT 0,
  skipped_keys INTEGER NOT NULL DEFAULT 0,
  error_keys INTEGER NOT NULL DEFAULT 0,
  migrated_bytes INTEGER NOT NULL DEFAULT 0,

  dirty_keys_seen INTEGER NOT NULL DEFAULT 0,
  dirty_keys_applied INTEGER NOT NULL DEFAULT 0,
  dirty_keys_deleted INTEGER NOT NULL DEFAULT 0,

  last_error TEXT
);
```

### Dirty keys table

```sql id="4x3p9c"
CREATE TABLE migration_dirty_keys (
  run_id TEXT NOT NULL,
  key BLOB NOT NULL,

  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  events_count INTEGER NOT NULL DEFAULT 1,

  last_event TEXT,                    -- e.g. "set","hset","del","expire","expired"
  state TEXT NOT NULL DEFAULT "dirty", -- dirty|applied|deleted|skipped|error

  PRIMARY KEY (run_id, key)
);

CREATE INDEX migration_dirty_keys_state_idx
  ON migration_dirty_keys(run_id, state);

CREATE INDEX migration_dirty_keys_last_seen_idx
  ON migration_dirty_keys(run_id, last_seen_at);
```

### Optional: error log (bounded)

To avoid exploding database size, log only errors and a small bounded sample:

```sql id="3o3xga"
CREATE TABLE migration_errors (
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  key BLOB,
  stage TEXT NOT NULL,         -- bulk|dirty_apply|verify
  message TEXT NOT NULL
);
CREATE INDEX migration_errors_at_idx ON migration_errors(run_id, at);
```

## F.5.2 Registry update semantics

When the tracker sees an event for key `K`:

* Insert if not present:

  * `first_seen_at = now`, `last_seen_at = now`, `events_count = 1`, `last_event = event`
* If present:

  * `last_seen_at = now`
  * `events_count += 1`
  * `last_event = event`
  * `state = "dirty"` unless state is terminal (`deleted` can be reverted to dirty if a new write arrives)

This is a **set-like deduplicated registry** with useful metadata.

---

# F.6 Event Capture: Mapping Notifications to Dirty Keys

## F.6.1 Channel subscription strategy

Prefer subscribing to **keyevent** channels because they give you the event name, not only the keyspace operation.

Examples (conceptual):

* `__keyevent@0__:set`
* `__keyevent@0__:hset`
* `__keyevent@0__:del`
* `__keyevent@0__:expire`
* `__keyevent@0__:expired`

The payload is the key name.

If only keyspace notifications are available, you will receive:

* channel includes the key, payload includes the event
  You must support both, but keyevent is simpler.

## F.6.2 Events to treat as “dirty”

Mark key as dirty when you see any of:

* `set`, `mset`, `incrby`, etc. (string writes)
* `hset`, `hdel`, `hincrby`, etc.
* `sadd`, `srem`, etc.
* `lpush`, `rpush`, `lpop`, `rpop`, etc.
* `zadd`, `zrem`, etc.
* `expire`, `pexpire`, `persist` (TTL changes)

## F.6.3 Events to treat as “deleted”

Mark key as deleted when you see:

* `del` / `unlink` event
* `expired` event

**Important:** A key can be deleted and later recreated. If a write event arrives after a deleted mark, you must set state back to `dirty`.

## F.6.4 Limitations and mitigation

Keyspace notifications are not a guaranteed durable log:

* if the tracker disconnects, events can be missed
  Mitigation:
* treat the final cutover delta as authoritative with the application frozen
* optionally run one short SCAN after freeze as a “safety sweep” if you want extra assurance

---

# F.7 Bulk Importer Behavior (No Patterns)

## F.7.1 Bulk scan loop

* Use `SCAN cursor COUNT scan_count_hint`
* For each returned key:

  1. `TYPE key`
  2. If type unsupported: `skipped_keys++`
  3. Else fetch full value depending on type:

     * string: `GET`
     * hash: `HGETALL`
     * set: `SMEMBERS`
     * list: `LRANGE 0 -1` (if lists supported)
     * zset: `ZRANGE 0 -1 WITHSCORES` (if zsets supported)
  4. `PTTL key` (preserve TTL)
  5. Write to destination in one batch transaction

## F.7.2 Checkpointing

Persist:

* cursor
* counters
* last update time
  every N seconds or every M keys.

If interrupted, `--resume` restarts from the stored cursor.

## F.7.2.1 Graceful shutdown (SIGINT / SIGTERM)

When the bulk import process receives SIGINT or SIGTERM it must:

* Stop the import loop after the current key (no partial key).
* Write a final checkpoint (cursor and counters) so progress is persisted.
* Set run status to `aborted`.
* Close the SQLite database handle so WAL is checkpointed and the file is not left open.
* Remove signal handlers and exit (rethrow so the process exits non-zero).

This ensures the destination DB is always closed cleanly when the process is killed or interrupted; the next run with `--resume` continues from the last checkpoint.

## F.7.3 Throughput controls

The importer must support:

* `max_concurrency`: number of inflight fetches
* `max_rps`: throttle reads against Redis
* `batch_keys` / `batch_bytes`: commit grouping

---

# F.8 Delta Apply (Using Dirty Key Registry)

## F.8.1 When to run delta

* During cutover window, with application writes frozen.
* Optional: run a “pre-delta” while still live to reduce final delta size.

## F.8.2 Delta algorithm

Repeat until no dirty keys remain:

1. Select dirty keys in batches:

   ```sql
   SELECT key
   FROM migration_dirty_keys
   WHERE run_id=? AND state="dirty"
   ORDER BY last_seen_at ASC
   LIMIT ?;
   ```
2. For each key:

   * Check existence in Redis:

     * Option A: attempt `TYPE`. If `none`, treat as deleted.
   * If deleted:

     * `DEL key` on RespLite destination
     * mark state = `deleted`
     * increment `dirty_keys_deleted`
   * Else:

     * fetch by type (same as bulk)
     * fetch `PTTL`
     * write into RespLite
     * mark state = `applied`
     * increment `dirty_keys_applied`

All writes should update progress counters in `migration_runs`.

## F.8.3 Safety sweep (optional but recommended for large/high-write systems)

After freeze begins and delta completes:

* run a quick SCAN pass limited by time (or a full pass if feasible)
* compare to destination by spot checks or reimport a final time
  This is a belt-and-suspenders option.

---

# F.9 Suggested End-to-End Migration Process (Programmatic Example)

Assume:

* Redis source: `redis://10.0.0.10:6379`
* RespLite destination DB: `./resplite.db`
* Full migration without patterns
* Supported types: string/hash/set/list/zset
* Goal: minimal downtime

```javascript id="f9programmatic"
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createMigration } from 'resplite/migration';

const m = createMigration({
  from: 'redis://10.0.0.10:6379',
  to: './resplite.db',
  runId: 'run_2026_03_03',
  scanCount: 1000,
  batchKeys: 200,
  batchBytes: 64 * 1024 * 1024,
  maxRps: 2000,
});

const info = await m.preflight();
await m.enableKeyspaceNotifications();
await m.startDirtyTracker();

const total = info.keyCountEstimate || 1;
await m.bulk({
  resume: true,
  onProgress: (r) => {
    const pct = ((r.scanned_keys / total) * 100).toFixed(1);
    console.log(`bulk ${pct}% scanned=${r.scanned_keys} migrated=${r.migrated_keys}`);
  },
});

console.log(m.status());

const rl = createInterface({ input: stdin, output: stdout });
await rl.question('Freeze writes to Redis, then press Enter to apply the final dirty set...');
rl.close();

await m.applyDirty();
await m.stopDirtyTracker();

const verify = await m.verify({ samplePct: 0.5, maxSample: 10000 });
console.log(verify);

await m.close();
```

Notes:

* Start dirty tracking before bulk so it captures writes during the whole import.
* Keep the tracker running until after the final `applyDirty()`.
* The cutover window is: freeze writes to Redis, apply the remaining dirty set, stop the tracker, then switch clients to RespLite.
* `status()` is synchronous and can be polled at any point from the destination DB.

---

# F.10 Progress Reporting and Controls

## F.10.1 Progress output requirements

Both bulk importer and dirty applier must print and persist:

* scanned_keys, migrated_keys, migrated_bytes
* dirty_keys_seen, dirty_keys_applied, dirty_keys_deleted
* current cursor
* rates (keys/s, MB/s)
* recent errors summary
* checkpoint time

## F.10.2 Runtime controls

Provide:

* `pause`, `resume`, `abort`
* adjust `max_concurrency`, `max_rps`
* adjust `batch_keys`, `scan_count`

Implementation may use:

* updating `migration_runs.status`
* a simple control file
* or another control surface that updates the SQLite run row

---

# F.11 Failure and Recovery Rules

## F.11.1 Tracker disconnect

If dirty tracker disconnects:

* it must attempt reconnect with backoff
* record a warning in `migration_errors`
* migration can proceed, but final delta should be done after freeze (which provides correctness)

## F.11.2 Importer crash/restart

* On restart with resume enabled, continue from stored cursor.
* Already migrated keys may be overwritten idempotently.

## F.11.3 Idempotency requirements

* Bulk and dirty apply must be safe to rerun:

  * writes should upsert
  * deletions should be no-op if missing

---

# F.10 Search Index Migration (FT.* / RediSearch)

## F.10.1 Overview

When the source is a Redis instance with **RediSearch** (Redis Stack or the `redis/search` module), search indices can be migrated with the `migrate-search` step. This step is independent of the KV bulk import and can be run at any time (before or after `bulk`).

## F.10.2 Algorithm

For each index in the source:

1. **`FT._LIST`** → enumerate all index names.
2. **`FT.INFO <name>`** → read `index_definition` (key type, prefix patterns) and `attributes` (field names and types).
3. **Schema mapping** (see §F.10.3).
4. **`FT.CREATE`** in RespLite with the mapped schema. Skip if already exists (controlled by `skipExisting`).
5. **SCAN** keys matching each index prefix → **HGETALL** → `addDocument` in SQLite batches.
6. **`FT.SUGGET "" MAX n WITHSCORES`** → import suggestions into RespLite.

## F.10.3 Field type mapping

| RediSearch type | RespLite type | Notes |
|-----------------|---------------|-------|
| TEXT            | TEXT          | Direct mapping |
| TAG             | TEXT          | Values preserved as-is; TAG filtering semantics lost |
| NUMERIC         | TEXT          | Values stored as strings; numeric range queries not supported |
| GEO, VECTOR, … | —             | Skipped with warning |

RespLite requires a `payload` TEXT field. If none of the source fields maps to `payload`, a `payload` field is added automatically and synthesised at import time by concatenating all other text values.

## F.10.4 Constraints

* Only **HASH**-based indices are supported (`key_type = HASH`). JSON indices (RedisJSON) are skipped with an error.
* Index names must match `[A-Za-z][A-Za-z0-9:_-]{0,63}`. Indices with invalid names are skipped with an error.
* `FT.SUGGET` has no cursor; suggestions are imported up to `maxSuggestions` (default 10 000).
* Document score is read from the `__score` or `score` hash field if present; defaults to `1.0`.

## F.10.5 Graceful shutdown

Same pattern as `bulk` (§F.7.2.1): SIGINT/SIGTERM finishes the current document, closes the SQLite DB cleanly, and exits with a non-zero code.

## F.10.6 Programmatic API

```javascript
const m = createMigration({ from, to, runId });

const result = await m.migrateSearch({
  onlyIndices:    ['products', 'articles'], // omit for all
  batchDocs:      200,
  maxSuggestions: 10000,
  skipExisting:   true,
  withSuggestions: true,
  onProgress: (r) => console.log(r.name, r.docsImported, r.warnings),
});
// result: { indices: [{ name, created, skipped, docsImported, docsSkipped, docErrors, sugsImported, warnings, error? }], aborted }
```

---

# F.12 Operational Guidance (Large datasets)

* Use a dedicated Redis replica for reads if possible to reduce load on primary.
* Keep `max_concurrency` conservative at first; increase only if Redis latency remains stable.
* Keep dirty tracker running from before bulk starts until just before cutover switch.
* Prefer application-level maintenance mode for freeze.
