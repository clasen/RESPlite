# RESPLite Specification v1 — Cache and Architecture

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
