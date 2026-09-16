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

## 6.1 Optional scripting extension

Scripting is enabled per server by injecting a prepared plugin from `resplite/scripting`. For trusted application scripts, start with Fengari: install it in the application and pass its module to `createFengariScripting(fengari)`. Wasmoon is the alternative when per-state memory limits and protected-call-resistant timeouts are required. RESPLite has no production dependency on either Lua library. Existing startup signatures remain unchanged.

The extension supports `EVAL script numkeys [keys...] [args...]`, `EVALSHA sha numkeys [keys...] [args...]`, `SCRIPT LOAD script`, `SCRIPT EXISTS sha [sha...]`, and `SCRIPT FLUSH [SYNC]`. Unsupported subcommands, including `ASYNC`, return errors. Without a plugin these commands remain unsupported and absent from `COMMAND`; with it, introspection reports scripting arities and movable keys for EVAL/EVALSHA.

`KEYS` and `ARGV` are one-based Lua arrays. The bridge exposes `redis.call`, `redis.pcall`, `redis.error_reply` and `redis.status_reply`. It reuses existing data handlers under the server's command policy. The allowed command set is explicit in `src/scripting/commands.js`; administrative, blocking, Pub/Sub, FT.* and recursive scripting commands are excluded. Hooks and MONITOR observe the outer request only.

RESP2 null becomes Lua false; Lua false/nil returns null, true returns integer 1, and finite numbers are truncated within JavaScript's safe integer range. Lua arrays stop at their first nil; status/error tables work at every array level. Cyclic replies and replies deeper than 128 tables fail. Keys, arguments, source and bulk strings are binary-safe. Error/status strings are sanitized single-line text.

Each invocation creates and closes a Lua state (Lua 5.3 with Fengari, Lua 5.4 with Wasmoon) with basic functions and string/table/math libraries. No filesystem, OS, JavaScript, loaders, metatable APIs, coroutines or external bytecode are exposed. Only the trusted internal bootstrap is compiled once per supplied Lua module and reused as bytecode. The source cache is per plugin, SHA-1 keyed, in-memory and LRU bounded. Valid EVAL source is cached before execution, even when execution fails; SCRIPT LOAD compiles without executing. EVALSHA reuses the known SHA-1, refreshes LRU and recompiles source; SCRIPT EXISTS does not refresh it. Missing/evicted hashes return NOSCRIPT. Closing or flushing clears the source cache.

Operational limits and validation live in `src/scripting/config.js`: timeout 1,000 ms, Lua memory 16 MiB (Wasmoon only), source 256 KiB, 256 cached scripts and 4 MiB cached source, overridable through the adapter. Sources exceeding either individual or total cache byte capacity fail. Wasmoon timeouts suspend execution or escape native callback boundaries and cannot be caught by Lua protected calls; Fengari has the limitations described below. Checks cannot preempt a synchronous SQLite/native Lua operation. Limits do not bound total host/WASM memory.

The plugin is exclusively attached to one server. Servers close owned plugins on shutdown or startup failure; manual wiring closes explicitly. Shared Lua modules are allowed with separate plugins. Full Lua 5.1 compatibility, auxiliary Redis libraries, SCRIPT KILL/BUSY, Functions and script persistence remain out of scope. See spec 03 for atomicity and error semantics.

### Fengari adapter (trusted scripts)

`createFengariScripting(fengari, options)` accepts the consumer's `fengari@0.1.5` module synchronously. Fengari is a development dependency only; the package never imports it at runtime. `plugin.js` owns the common command validation, source cache, dispatch and lifecycle. `lua-common.js` defines the shared bootstrap and RESP2 conversions; each runtime owns its state creation, byte transfer and interruption mechanism.

This adapter is stable for application-controlled, trusted scripts. All callers allowed to execute or load scripts must be trusted; the adapter is not a sandbox for untrusted scripts. It implements the same scripting commands and fresh-state isolation using Lua 5.3, 32-bit integers and double-precision floats. Integer arithmetic can wrap at 32 bits, so scripts are not numerically interchangeable with Redis Lua 5.1 or Wasmoon Lua 5.4. Only the internal bootstrap bytecode is reused. Source size/count/cache limits and timeout defaults are shared through `FENGARI_DEFAULTS`; `maxMemoryBytes` is unsupported and rejected, because allocations are managed by the JavaScript GC.

Fengari's instruction hook suspends yieldable loops. Inside native callbacks it raises a Lua error that protected calls can catch repeatedly, so the timeout is not a guaranteed termination boundary. The bridge refuses further commands after the deadline, and writes before failure remain applied. Native/SQLite calls cannot be preempted. Benchmarks use an external process watchdog; Wasmoon's stronger memory and timeout guarantees remain specific to its adapter.

### Wasmoon adapter (resource limits)

`createWasmoonScripting(luaModule, options)` accepts `await new LuaFactory().getLuaModule()` from the application's `wasmoon@1.16.0` installation (Lua 5.4). It supports `maxMemoryBytes` and timeouts that cannot be suppressed by Lua protected calls. Synchronous SQLite/native Lua operations cannot be preempted, and the memory cap applies only to Lua state allocations. Wasmoon is a development dependency only; RESPLite never imports it at runtime.

---

## 7. Commands Explicitly Not Supported in v1

The following commands are out of scope in v1 and should return a clear unsupported-command error:

- `MULTI`
- `EXEC`
- `WATCH`
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
