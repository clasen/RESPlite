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
- `MSETNX`
- `DEL`
- `UNLINK`
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
- `HSETNX`
- `HMSET` (legacy compatibility alias)
- `HGET`
- `HMGET`
- `HGETALL`
- `HKEYS`
- `HVALS`
- `HDEL`
- `HEXISTS`
- `HLEN`
- `HSTRLEN`
- `HINCRBY`
- `HINCRBYFLOAT`
- `HSCAN`
- `HRANDFIELD`
- `HEXPIRE`
- `HPEXPIRE`
- `HEXPIREAT`
- `HPEXPIREAT`
- `HTTL`
- `HPTTL`
- `HEXPIRETIME`
- `HPEXPIRETIME`
- `HPERSIST`

Hash field expiration is stored as an absolute Unix timestamp in milliseconds. `HSET` clears the expiration of fields it writes; `HINCRBY` and `HINCRBYFLOAT` preserve an existing field expiration. `HSETNX`, multi-field writes, numeric mutations, and expiration updates are atomic SQLite operations.

### 6.5 Set commands

Supported:

- `SADD`
- `SREM`
- `SMEMBERS`
- `SISMEMBER`
- `SMISMEMBER`
- `SCARD`

### 6.6 Introspection and navigation

Supported:

- `TYPE`
- `OBJECT IDLETIME` (seconds since last write; uses `updated_at`; missing key returns nil)
- `SCAN`

### 6.7 Database commands

Supported:

- `DBSIZE`
- `FLUSHDB [ASYNC | SYNC]`
- `FLUSHALL [ASYNC | SYNC]`

RESPlite exposes one logical database, so `FLUSHDB` and `FLUSHALL` are equivalent. The `SYNC` and `ASYNC` modifiers are accepted for client compatibility; both execute synchronously on SQLite. A flush removes the keyspace and all `FT.*` data while preserving internal migration bookkeeping.

### 6.8 Administrative extension commands

Supported as project-specific commands:

- `SQLITE.INFO`
- `CACHE.INFO`

These are not Redis-standard commands.
They exist for observability and operational insight.

### 6.9 Pub/Sub commands

Supported:

- `PUBLISH channel message`
- `SUBSCRIBE channel [channel ...]`
- `UNSUBSCRIBE [channel ...]`
- `PSUBSCRIBE pattern [pattern ...]`
- `PUNSUBSCRIBE [pattern ...]`
- `PUBSUB CHANNELS [pattern]`
- `PUBSUB NUMSUB [channel ...]`
- `PUBSUB NUMPAT`

Pub/Sub uses RESP2 push-style array replies and at-most-once delivery. Channels, patterns, and messages are binary-safe. Subscription state is held in memory by one RESPLite server instance and is independent of SQLite and the keyspace; it is not persisted or shared by separate processes opening the same database.

While a RESP2 connection has active channel or pattern subscriptions, it accepts only `SUBSCRIBE`, `UNSUBSCRIBE`, `PSUBSCRIBE`, `PUNSUBSCRIBE`, `PING`, and `QUIT`. Direct and pattern matches are separate deliveries and each contributes to the integer returned by `PUBLISH`. `PUBSUB NUMPAT` reports the number of unique active patterns, while `PUBLISH` counts delivery to every matching subscribed client.

---

## 7. Commands Explicitly Not Supported in v1

The following commands are out of scope in v1 and should return a clear unsupported-command error:

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
