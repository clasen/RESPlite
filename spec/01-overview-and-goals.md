# RESPLite Specification v1 — Overview and Goals

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
