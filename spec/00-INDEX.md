# RESPLite Specifications — Index

Specifications are split by topic. Names are specific and ordered by dependency.

## Core (RESP server v1)

| File | Content |
|------|--------|
| [01-overview-and-goals.md](01-overview-and-goals.md) | Overview, product goals, non-goals, positioning |
| [02-protocol-and-commands.md](02-protocol-and-commands.md) | Protocol (RESP2), command scope, semantics, SET scope |
| [03-data-model-ttl-transactions.md](03-data-model-ttl-transactions.md) | Data model (SQLite schema), TTL/expiration, transaction rules |
| [04-cache-architecture.md](04-cache-architecture.md) | Hot cache, architecture layers, internal API shape |
| [05-scan-admin-implementation.md](05-scan-admin-implementation.md) | SCAN, admin commands (SQLITE.INFO, CACHE.INFO), project structure, testing, acceptance, implementation order |
| [06-migration-strategy-core.md](06-migration-strategy-core.md) | Migration strategy from Redis (programmatic), compatibility matrix, final design rule |

## Data types (beyond base v1)

| File | Content |
|------|--------|
| [07-type-lists.md](07-type-lists.md) | Lists (LPUSH, RPUSH, LPOP, RPOP, LLEN, LRANGE, LINDEX, …) — data model and behavior |
| [08-type-sorted-sets.md](08-type-sorted-sets.md) | Sorted sets (ZADD, ZREM, ZCARD, ZSCORE, ZRANGE, ZRANGEBYSCORE) — data model and behavior |
| [09-search-ft-commands.md](09-search-ft-commands.md) | Search (FT.CREATE, FT.ADD, FT.SEARCH, FT.SUG*, …) — FTS5/BM25, schema, parser grammar |
| [10-blocking-commands.md](10-blocking-commands.md) | Blocking list commands (BLPOP, BRPOP) — wait model, wakeup, tests |

## Migration (dirty key registry)

| File | Content |
|------|--------|
| [11-migration-dirty-registry.md](11-migration-dirty-registry.md) | Bulk import, dirty key tracker, delta apply, search index migration, operational guidance |

---

## Implementation status (as of review)

- **Implemented:** All commands in §02 (connection, strings, TTL, hashes, sets, SCAN, admin), plus Lists (§07), Sorted Sets (§08), FT.* (§09), BLPOP/BRPOP (§10). Migration API with bulk, dirty tracker, apply-dirty, migrateSearch (§11).
- **Schema:** Matches §03 and extends to list/zset/search tables per §07, §08, §09.
- **Specs:** SPEC_A–F have been split into the files above; content is unchanged except in Appendix F: the duplicate “F.10 Search Index Migration” was renumbered to **F.12**, and “F.12 Operational Guidance” to **F.13**.
