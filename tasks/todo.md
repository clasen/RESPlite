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
