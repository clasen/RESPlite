# RESPLite Specification v1 — SCAN, Admin Commands, Project Structure, Testing

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
      ...
    integration/
      ...
    contract/
      ...
    stress/
      ...
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

Infrastructure: TCP server, RESP parser/encoder, command registry, SQLite init, error model, protocol tests.

### Phase 2

Strings and core: PING, ECHO, GET, SET, DEL, EXISTS, TYPE.

### Phase 3

Expiration: EXPIRE, PEXPIRE, TTL, PTTL, PERSIST, lazy expiration, active sweeper.

### Phase 4

Numeric string operations: INCR, DECR, INCRBY, DECRBY.

### Phase 5

Hashes: HSET, HGET, HMGET, HGETALL, HDEL, HEXISTS, HINCRBY.

### Phase 6

Sets: SADD, SREM, SMEMBERS, SISMEMBER, SCARD.

### Phase 7

Introspection and observability: SCAN, SQLITE.INFO, CACHE.INFO.

### Phase 8

Migration tooling: programmatic Redis migration API using SCAN, import verification and reporting.

### Phase 9

Search extension: FT.CREATE, FT.SEARCH, FT.INFO, FT.DROPINDEX (SQLite FTS5 with BM25).

Search should only begin after the core command, TTL, persistence, and concurrency suites are stable.
