# Migration from Redis (SPEC §26)

## Plan

- [x] Review SPEC §26 (Migration Strategy) and §10 (Data model)
- [x] Implement external CLI tool (not part of RESP server)
- [x] Method: connect to Redis → SCAN → TYPE → fetch by type (GET / HGETALL / SMEMBERS) → PTTL → write to SQLite
- [x] Migratable subset: strings, hashes, sets, TTL metadata
- [x] Skip unsupported types (list, zset, stream, etc.) with report
- [x] Contract test using local Redis (skip if Redis unavailable)

## Implementation

- **CLI**: `src/cli/import-from-redis.js` — `node src/cli/import-from-redis.js --redis-url redis://127.0.0.1:6379 --db ./migrated.db`
- **Storage**: Reuse existing `openDb`, `createKeysStorage`, `createStringsStorage`, `createHashesStorage`, `createSetsStorage`; write via storage layer with Buffer values
- **Binary safety**: Redis client returns strings; coerce to Buffer (utf8) when writing to SQLite

## Verification

- Run contract test: `npm run test:contract` (includes import-from-redis test when Redis is available)
- Manual: populate local Redis, run CLI, start RESPlite with migrated db, verify keys/values/TTL

## Not in scope (SPEC §26.3)

- RDB parsing, AOF parsing, mirror mode, dual-write

---

# Migration with Dirty Key Registry (SPEC_F)

## Done

- [x] Migration schema: `migration_runs`, `migration_dirty_keys`, `migration_errors` in `src/storage/sqlite/migration-schema.js`
- [x] Registry layer: `src/migration/registry.js` (createRun, getRun, updateBulkProgress, upsertDirtyKey, getDirtyBatch, markDirtyState, logError, getDirtyCounts)
- [x] Bulk importer: `src/migration/bulk.js` with run_id, checkpointing, resume, max_rps, batch_keys/batch_bytes, pause/abort via status
- [x] Shared import-one: `src/migration/import-one.js` (fetch key from Redis + write to storages; used by bulk and apply-dirty)
- [x] Delta apply: `src/migration/apply-dirty.js` (apply dirty keys from registry: reimport or delete in destination)
- [x] Preflight: `src/migration/preflight.js` (key count, type distribution, notify-keyspace-events check, recommendations)
- [x] Verify: `src/migration/verify.js` (sample keys, compare Redis vs RespLite)
- [x] CLI `resplite-import`: `src/cli/resplite-import.js` (preflight, bulk, status, apply-dirty, verify)
- [x] CLI `resplite-dirty-tracker`: `src/cli/resplite-dirty-tracker.js` (start = PSUBSCRIBE keyevent, stop = update run status)
- [x] package.json `bin`: resplite-import, resplite-dirty-tracker
- [x] Unit tests: `test/unit/migration-registry.test.js`
- [x] README: minimal-downtime migration flow and commands
