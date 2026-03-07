# RESPLite Specification v1 — Protocol and Commands

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
- `SETEX`
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
- `OBJECT IDLETIME` (seconds since last write; uses `updated_at`; missing key returns nil)
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
