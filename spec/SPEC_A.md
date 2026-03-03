# RESPLite Specification v1

## 1. Overview

RESPLite is a Redis-compatible subset server implemented in Node.js and backed by SQLite.
It exposes a TCP port that speaks RESP2 so existing Redis clients can connect to it.
The system is designed for single-node deployments where persistence, low operational overhead, and practical Redis compatibility matter more than full Redis feature parity.

This project is not a full Redis clone.
It is a RESP server with Redis-like semantics for a carefully selected subset of commands that map naturally and efficiently to SQLite.

Core principles:

- RESP-first product design
- SQLite as the persistent source of truth
- Hot in-memory cache for frequently accessed data
- Strictly scoped compatibility
- Strong correctness and test coverage before feature expansion
- No features that require unnatural or fragile implementation on SQLite

---

## 2. Product Goals

Version 1 focuses on the following goals:

- Expose a TCP server that speaks RESP2
- Support a useful subset of Redis commands
- Persist all data in SQLite
- Maintain practical compatibility with existing Redis clients
- Support strings, hashes, sets, and TTLs
- Provide SCAN and TYPE for basic introspection
- Keep the architecture ready for future FT.* commands powered by SQLite FTS5 with BM25 ranking

This project is intended to be packaged and distributed as an npm module, but v1 starts with RESP server mode only.
There is no embedded direct JavaScript API in the initial scope.

---

## 3. Non-Goals

The following are explicitly out of scope for v1:

- Pub/Sub
- Streams
- Lua scripting
- Redis Cluster
- Replication
- MULTI / EXEC / WATCH
- Blocking commands such as BLPOP
- Multiple logical databases via SELECT
- Full edge-case parity with Redis for every command and protocol nuance
- Matching Redis performance for high-concurrency, memory-first workloads

The project should return a clear error for unsupported commands:

- `ERR command not supported yet`

---

## 4. Positioning

RESPLite should be described as:

> A RESP2 server with practical Redis compatibility, backed by SQLite for persistent single-node workloads.

It should not be described as:

- a full Redis replacement for all workloads
- a Redis Cluster alternative
- a low-latency in-memory data store competitor for large-scale write-heavy systems

The intended sweet spot is:

- bots
- internal tools
- small to medium web applications
- persistent caches
- local development environments
- low-ops VPS deployments
- metadata stores
- feature flags
- counters
- session-like state where persistence matters

---

## 5. Protocol

### 5.1 Supported protocol version

v1 supports:

- RESP2 only

RESP3 is out of scope for v1.

### 5.2 Wire compatibility target

The server should be compatible enough for practical use with:

- `redis-cli`
- the official `redis` npm client

The wire-level contract must correctly support:

- Simple Strings
- Bulk Strings
- Null Bulk Strings
- Integers
- Arrays
- Errors

### 5.3 Binary safety

The implementation must treat the following as binary-safe values:

- keys
- string values
- hash fields
- hash values
- set members

Internal command processing should use `Buffer` objects, not UTF-8 strings, as the default representation.
SQLite storage should use `BLOB` columns where appropriate.

---

## 6. Command Scope for v1

### 6.1 Connection and basic commands

Supported:

- `PING`
- `ECHO`
- `QUIT`

### 6.2 String commands

Supported:

- `GET`
- `SET`
- `MGET`
- `MSET`
- `DEL`
- `EXISTS`
- `INCR`
- `DECR`
- `INCRBY`
- `DECRBY`

### 6.3 TTL commands

Supported:

- `EXPIRE`
- `PEXPIRE`
- `TTL`
- `PTTL`
- `PERSIST`

### 6.4 Hash commands

Supported:

- `HSET`
- `HGET`
- `HMGET`
- `HGETALL`
- `HDEL`
- `HEXISTS`
- `HINCRBY`

### 6.5 Set commands

Supported:

- `SADD`
- `SREM`
- `SMEMBERS`
- `SISMEMBER`
- `SCARD`

### 6.6 Introspection and navigation

Supported:

- `TYPE`
- `SCAN`

### 6.7 Administrative extension commands

Supported as project-specific commands:

- `SQLITE.INFO`
- `CACHE.INFO`

These are not Redis-standard commands.
They exist for observability and operational insight.

---

## 7. Commands Explicitly Not Supported in v1

The following commands are out of scope in v1 and should return a clear unsupported-command error:

- `SUBSCRIBE`
- `PUBLISH`
- `PSUBSCRIBE`
- `MULTI`
- `EXEC`
- `WATCH`
- `EVAL`
- `EVALSHA`
- `XADD`
- `XRANGE`
- `XREAD`
- `ZADD`
- `ZRANGE`
- `LPUSH`
- `RPUSH`
- `BLPOP`
- `SELECT`

Future support may be considered only if the implementation maps cleanly to SQLite.

---

## 8. Semantic Rules

### 8.1 Type ownership

A key has exactly one logical type at a time.
Supported types in v1:

- `string`
- `hash`
- `set`

If a command targets a key of the wrong type, the server must return:

- `WRONGTYPE Operation against a key holding the wrong kind of value`

### 8.2 Missing keys

Behavior should follow Redis-like semantics where reasonable.
Examples:

- `GET missing` returns null bulk string
- `TTL missing` returns `-2`
- `PTTL missing` returns `-2`
- `TYPE missing` returns `none`

### 8.3 Keys without expiration

For existing keys without expiration:

- `TTL key` returns `-1`
- `PTTL key` returns `-1`

### 8.4 DEL and EXISTS

- `DEL` returns the count of removed keys
- `EXISTS` returns the count of keys that exist

### 8.5 Numeric string commands

`INCR`, `DECR`, `INCRBY`, and `DECRBY` operate on string values interpreted as integers.
Rules:

- missing key behaves like zero, then the operation is applied
- non-integer content returns an error
- result is persisted as a string-compatible integer representation

### 8.6 Empty container behavior

For hashes and sets, when the last field or member is removed and the structure becomes empty, the logical key should be deleted as well.
This keeps the logical keyspace clean and avoids stale empty types.

---

## 9. SET Command v1 Scope

Supported forms in v1:

- `SET key value`
- `SET key value EX seconds`
- `SET key value PX milliseconds`

Not supported in v1:

- `NX`
- `XX`
- `GET`
- `KEEPTTL`

Invalid syntax should produce a Redis-style syntax error.

---

## 10. Data Model

SQLite is the persistent source of truth.
Data is stored in separate tables by logical type.
This avoids an overly generic storage model and keeps operations natural and efficient.

### 10.1 Key metadata table

```sql
CREATE TABLE redis_keys (
  key BLOB PRIMARY KEY,
  type INTEGER NOT NULL,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX redis_keys_expires_at_idx ON redis_keys(expires_at);
CREATE INDEX redis_keys_type_idx ON redis_keys(type);
```

Recommended type enum values:

- `1` = string
- `2` = hash
- `3` = set

Notes:

- `key` is stored as `BLOB`
- `expires_at` is an absolute timestamp in milliseconds
- `version` supports cache invalidation
- `updated_at` supports observability and future maintenance tasks

### 10.2 String storage

```sql
CREATE TABLE redis_strings (
  key BLOB PRIMARY KEY,
  value BLOB NOT NULL,
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);
```

### 10.3 Hash storage

```sql
CREATE TABLE redis_hashes (
  key BLOB NOT NULL,
  field BLOB NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (key, field),
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);
```

### 10.4 Set storage

```sql
CREATE TABLE redis_sets (
  key BLOB NOT NULL,
  member BLOB NOT NULL,
  PRIMARY KEY (key, member),
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);
```

---

## 11. TTL and Expiration

Expiration must be implemented in two complementary ways.

### 11.1 Lazy expiration

Before any command operates on a key, the engine should verify whether the key has expired.
If it has expired:

- the key must be removed from SQLite
- any cache entry must be invalidated
- the command should proceed as if the key does not exist

### 11.2 Active expiration

A background sweeper should periodically delete expired keys in batches.
Suggested configuration:

```js
{
  expiration: {
    sweepIntervalMs: 1000,
    maxKeysPerSweep: 500
  }
}
```

This does not need to guarantee exact expiration timing to the millisecond.
It must guarantee that expired keys behave as non-existent from the client's point of view.

---

## 12. Hot Cache

The cache is an optimization layer only.
SQLite remains the source of truth.

### 12.1 Purpose

The cache should reduce repeated reads from SQLite for hot keys.
It should not change logical behavior.

### 12.2 Cache candidates

Good initial cache candidates:

- strings
- small hashes
- small sets
- key metadata such as type and expiration

The cache should not aggressively optimize large result sets in v1.

### 12.3 Cache model

Suggested internal cache entry structure:

```js
{
  kind: "string" | "hash" | "set",
  version: number,
  expiresAt: number | null,
  value: Buffer | Map | Array
}
```

### 12.4 Invalidation strategy

Writes should update or invalidate cache entries immediately after a successful SQLite transaction.
Version values stored in `redis_keys` should be used to prevent stale cache reads.

### 12.5 Policy

The cache should start with an LRU policy and support limits such as:

```js
{
  cache: {
    maxEntries: 50000,
    maxBytes: 64 * 1024 * 1024
  }
}
```

---

## 13. Architecture

The implementation should be layered and protocol-independent at the core.

### 13.1 Core layers

1. TCP server layer
2. RESP parser and encoder layer
3. Command dispatcher layer
4. Engine layer with Redis-like semantics
5. SQLite storage layer
6. Cache layer
7. Expiration subsystem

### 13.2 Layer responsibilities

#### TCP server layer

Responsible for:

- accepting TCP connections
- reading data from sockets
- writing encoded RESP replies
- handling connection lifecycle

#### RESP layer

Responsible for:

- parsing incoming RESP2 frames
- handling fragmented packets and multiple commands per chunk
- encoding valid RESP2 responses

#### Command dispatcher

Responsible for:

- normalizing command names to uppercase
- routing commands to handlers
- returning supported or unsupported command results

#### Engine

Responsible for:

- key existence checks
- expiration handling
- type validation
- semantic correctness
- numeric operations
- cleanup of empty structures
- cache coordination

#### SQLite storage layer

Responsible for:

- schema creation and migration
- prepared statements
- transactions
- efficient per-type operations
- SQLite pragmas

#### Cache layer

Responsible for:

- storing hot results
- enforcing limits
- evicting entries
- exposing metrics

#### Expiration subsystem

Responsible for:

- lazy expiration checks
- active sweeps
- deletion batch limits

---

## 14. Internal API Shape

Even though v1 is RESP-only, the internal engine should expose clear semantic operations.
This keeps the system testable and prepares the codebase for a future embedded API if desired.

Suggested engine methods:

```js
engine.get(key)
engine.set(key, value, options)
engine.del(keys)
engine.exists(keys)
engine.expire(key, ttlMs)
engine.pttl(key)
engine.persist(key)

engine.hset(key, pairs)
engine.hget(key, field)
engine.hmget(key, fields)
engine.hgetall(key)
engine.hdel(key, fields)
engine.hexists(key, field)
engine.hincrby(key, field, amount)

engine.sadd(key, members)
engine.srem(key, members)
engine.smembers(key)
engine.sismember(key, member)
engine.scard(key)

engine.type(key)
engine.scan(cursor, options)
```

---

## 15. SQLite Behavior and Pragmas

The storage layer should use pragmatic defaults tuned for this workload.
Suggested initial pragmas:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA temp_store=MEMORY;
PRAGMA cache_size=-20000;
PRAGMA mmap_size=268435456;
```

These settings may later become configurable.

---

## 16. Transaction Rules

Every state-changing operation that spans multiple storage steps must run inside a SQLite transaction.

Examples:

### 16.1 SET

A SET operation may require:

- writing or updating metadata in `redis_keys`
- deleting rows from other type tables if type replacement is allowed for string-over-string writes only
- writing to `redis_strings`
- updating version and timestamp
- updating or invalidating cache

All logical storage changes must be atomic.

### 16.2 HSET

An HSET operation may require:

- creating key metadata if the key does not yet exist
- validating type if the key already exists
- inserting or updating one or more fields
- updating version and timestamp
- updating or invalidating cache

### 16.3 SADD / SREM

Set modifications must update:

- membership rows
- metadata timestamps and versions
- key existence if the set becomes empty
- cache state

---

## 17. SCAN Behavior

SCAN is part of the v1 scope.

### 17.1 Minimum supported form

Required in v1:

- `SCAN cursor`

### 17.2 Response shape

The response should follow Redis-like shape:

- next cursor
- array of keys

### 17.3 Implementation note

A simple initial strategy is acceptable, such as lexicographic traversal over `redis_keys.key`.

### 17.4 Future extensions

Possible later additions:

- `MATCH pattern`
- `COUNT n`

These are not required in the first implementation.

---

## 18. Administrative Commands

### 18.1 SQLITE.INFO

This command should expose useful operational information such as:

- database path
- SQLite version
- counts by type
- total logical key count
- WAL mode status if available

### 18.2 CACHE.INFO

This command should expose cache information such as:

- cache enabled or disabled
- entry count
- estimated memory use
- hit count
- miss count
- hit ratio if available

These commands are intended for observability and debugging.

---

## 19. Future Search Scope

Search is not part of the base v1 implementation, but the architecture must remain compatible with a near-term v1.1 search layer.

### 19.1 Search vision

The future search subsystem should provide RediSearch-inspired commands powered by SQLite FTS5 with BM25 ranking.

Candidate commands:

- `FT.CREATE`
- `FT.SEARCH`
- `FT.INFO`
- `FT.DROPINDEX`

### 19.2 Recommended document model

The preferred future approach is to index hashes as documents.
Example logical model:

- `article:1` stored as a hash
- an index with prefix `article:`
- fields such as `title`, `body`, and `category`

### 19.3 Backend strategy

- SQLite FTS5 virtual tables
- BM25 ranking
- auxiliary metadata tables for filtering and sorting

The project should not attempt to fully clone RediSearch grammar or behavior at the start.
A clean, reduced, Redis-like search surface is preferable.

---

## 20. Project Structure

Recommended Node.js JavaScript ESM project layout:

```text
resplite/
  package.json
  README.md
  SPEC.md
  src/
    index.js
    server/
      tcp-server.js
      connection.js
    resp/
      parser.js
      encoder.js
      types.js
    commands/
      registry.js
      ping.js
      echo.js
      quit.js
      get.js
      set.js
      del.js
      exists.js
      expire.js
      pexpire.js
      ttl.js
      pttl.js
      persist.js
      incr.js
      decr.js
      incrby.js
      decrby.js
      type.js
      scan.js
      hset.js
      hget.js
      hmget.js
      hgetall.js
      hdel.js
      hexists.js
      hincrby.js
      sadd.js
      srem.js
      smembers.js
      sismember.js
      scard.js
      sqlite-info.js
      cache-info.js
    engine/
      engine.js
      errors.js
      expiration.js
      validate.js
    storage/
      sqlite/
        db.js
        schema.js
        pragmas.js
        keys.js
        strings.js
        hashes.js
        sets.js
        tx.js
    cache/
      lru.js
      cache.js
    util/
      buffers.js
      patterns.js
      clock.js
      logger.js
  test/
    helpers/
      server.js
      client.js
      tmp.js
      clock.js
      fixtures.js
    unit/
      resp-parser.test.js
      resp-encoder.test.js
      engine-strings.test.js
      engine-hashes.test.js
      engine-sets.test.js
      expiration.test.js
      cache.test.js
    integration/
      ping.test.js
      strings.test.js
      ttl.test.js
      hashes.test.js
      sets.test.js
      type.test.js
      scan.test.js
      restart-persistence.test.js
      wrongtype.test.js
      binary-safe.test.js
      multi-client.test.js
    contract/
      redis-cli-smoke.test.js
      redis-client.test.js
    stress/
      concurrency.test.js
      sweep-load.test.js
```

---

## 21. Implementation Stack

Recommended initial stack:

- Node.js
- JavaScript ESM
- `better-sqlite3`
- built-in `node:test`
- `assert/strict`
- `redis` npm package for contract tests

The v1 codebase should prioritize correctness, testability, and operational simplicity over TypeScript or extensive framework usage.

---

## 22. Testing Strategy

Testing is a first-class requirement.
A command is not considered implemented until it has meaningful coverage.

### 22.1 Testing categories

The project must include the following categories of tests:

- unit tests
- integration tests
- contract tests
- persistence tests
- expiration tests
- consistency tests
- concurrency tests
- protocol framing tests
- binary-safety tests

### 22.2 Per-command testing rule

Each supported command should have tests for:

- normal behavior
- missing-key behavior where applicable
- wrong-type behavior where applicable
- TTL interaction where applicable
- persistence across restart where applicable
- binary-safe behavior where applicable

### 22.3 RESP protocol tests

The RESP layer must be tested for:

- valid parsing of RESP2 types
- partial frames split across TCP chunks
- multiple commands arriving in a single TCP chunk
- correct encoding of all response types

### 22.4 Contract tests with real clients

v1 contract tests should use:

- `redis-cli`
- the official `redis` npm client

`ioredis` is not required in v1.
It may be added later as an additional compatibility suite.

### 22.5 Persistence tests

The project must verify:

- data survives server restart
- TTL metadata survives restart
- expired keys behave as missing after restart
- mixed key types remain valid after restart

### 22.6 Consistency tests

The project must verify internal invariants such as:

- rows in type tables must correspond to a valid row in `redis_keys`
- logical type must match actual storage table placement
- expired keys must not appear through command results
- empty hashes and sets are removed logically

### 22.7 Concurrency tests

The project must verify behavior under multiple clients, including:

- many concurrent INCR operations on the same key
- reads and writes overlapping across connections
- expiration sweeps occurring during active traffic
- restart safety under recent write activity

### 22.8 Performance sanity tests

The project does not need benchmark-grade tests in v1, but it should include sanity checks such as:

- repeated SET and GET operations at modest scale
- many TTL expirations without protocol failure
- SCAN on a non-trivial keyspace

---

## 23. Package Scripts

Suggested package scripts:

```json
{
  "type": "module",
  "scripts": {
    "test": "node --test",
    "test:unit": "node --test test/unit",
    "test:integration": "node --test test/integration",
    "test:contract": "node --test test/contract",
    "test:stress": "node --test test/stress",
    "test:all": "node --test test"
  }
}
```

---

## 24. Acceptance Criteria for Initial Milestone

The first meaningful milestone is achieved when the server can be exercised successfully through `redis-cli` and passes automated tests for the following sequence:

```text
PING
SET foo bar
GET foo
EXPIRE foo 10
TTL foo
DEL foo
HSET user:1 name Martin age 42
HGET user:1 name
HGETALL user:1
SADD tags a b c
SMEMBERS tags
TYPE foo
SCAN 0
```

In addition, the system must satisfy these conditions:

- persistence survives restart
- wrong-type errors are returned correctly
- expired keys behave as missing keys
- binary-safe values do not break command semantics
- multiple clients can connect and issue commands without corrupting state

---

## 25. Implementation Order

Recommended phased implementation order:

### Phase 1

Infrastructure:

- TCP server
- RESP parser
- RESP encoder
- command registry
- SQLite initialization and schema creation
- error model
- basic protocol tests

### Phase 2

Strings and core behavior:

- `PING`
- `ECHO`
- `GET`
- `SET`
- `DEL`
- `EXISTS`
- `TYPE`

### Phase 3

Expiration:

- `EXPIRE`
- `PEXPIRE`
- `TTL`
- `PTTL`
- `PERSIST`
- lazy expiration
- active sweeper

### Phase 4

Numeric string operations:

- `INCR`
- `DECR`
- `INCRBY`
- `DECRBY`

### Phase 5

Hashes:

- `HSET`
- `HGET`
- `HMGET`
- `HGETALL`
- `HDEL`
- `HEXISTS`
- `HINCRBY`

### Phase 6

Sets:

- `SADD`
- `SREM`
- `SMEMBERS`
- `SISMEMBER`
- `SCARD`

### Phase 7

Introspection and observability:

- `SCAN`
- `SQLITE.INFO`
- `CACHE.INFO`

### Phase 8

Migration tooling:

- external Redis import CLI using `SCAN`
- import verification and reporting

### Phase 9

Search extension:

- `FT.CREATE`
- `FT.SEARCH`
- `FT.INFO`
- `FT.DROPINDEX`

Search should only begin after the core command, TTL, persistence, and concurrency suites are stable.

---

## 26. Migration Strategy from Redis

Migration is not part of the RESP protocol surface in v1.
It should be implemented as an external CLI tool.

### 26.1 Initial migration method

Recommended initial approach:

- connect to a real Redis instance
- iterate keys using `SCAN`
- discover key type with `TYPE`
- fetch values according to type
- fetch expiration using `PTTL`
- write translated data into SQLite

### 26.2 Initial migratable subset

The initial import tool should support:

- strings
- hashes
- sets
- TTL metadata

### 26.3 Not required initially

- RDB parsing
- AOF parsing
- mirror mode
- dual-write migration

These can be considered later if adoption demands them.

---

## 27. Compatibility Matrix Guidance

The README should include a compatibility matrix with at least three groups:

### Supported

All commands implemented in v1.

### Planned

Future near-term commands such as:

- Redis import CLI
- `FT.CREATE`
- `FT.SEARCH`
- `FT.INFO`
- `FT.DROPINDEX`

### Not Supported

Features explicitly excluded from the roadmap for now, such as:

- Pub/Sub
- Streams
- Lua
- Cluster
- Replication
- Blocking commands

This matrix is essential for setting correct user expectations.

---

## 28. Final Design Rule

A command should only be added if its implementation is:

- natural on SQLite
- semantically clear
- testable
- operationally safe
- maintainable without excessive special handling

If a command requires too much implementation gymnastics to preserve Redis-like behavior, it should not be part of the supported surface until a clean design exists.

This rule is central to the project.
It protects correctness, keeps the scope honest, and preserves the identity of RESPLite as a practical Redis-compatible server built on top of SQLite rather than a fragile imitation.
