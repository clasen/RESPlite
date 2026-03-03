# RESPLite

A RESP2 server with practical Redis compatibility, backed by SQLite for persistent single-node workloads.

## Overview

RESPLite is not a full Redis clone. It is a RESP server with Redis-like semantics for a carefully selected subset of commands that map naturally to SQLite. Ideal for small to medium applications, persistent caches, local development, and low-ops deployments.

- **Zero external services** — just Node.js and a SQLite file.
- **Drop-in compatible** — works with the official `redis` npm client and `redis-cli`.
- **Persistent by default** — data survives restarts without snapshots or AOF.
- **Embeddable** — start the server and connect from the same script (see examples below).

## Install

```bash
npm install resplite
```

## Quick start (standalone server)

```bash
npm start
```

By default the server listens on port **6379** and stores data in `data.db` in the current directory.

```bash
redis-cli -p 6379
> PING
PONG
> SET foo bar
OK
> GET foo
"bar"
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `RESPLITE_PORT` | `6379` | Server port |
| `RESPLITE_DB` | `./data.db` | SQLite database file |
| `RESPLITE_PRAGMA_TEMPLATE` | `default` | SQLite PRAGMA preset (see below) |

### PRAGMA templates

| Template | Description | Key settings |
|---|---|---|
| `default` | Balanced durability and speed (recommended) | WAL, synchronous=NORMAL, 20 MB cache |
| `performance` | Maximum throughput, reduced crash safety | WAL, synchronous=OFF, 64 MB cache, 512 MB mmap, exclusive locking |
| `safety` | Crash-safe writes at the cost of speed | WAL, synchronous=FULL, 20 MB cache |
| `minimal` | Only WAL + foreign keys | WAL, foreign_keys=ON |
| `none` | No pragmas applied — pure SQLite defaults | — |

## Programmatic usage (embedded)

RESPLite can be started and consumed entirely within a single Node.js script — no separate process needed. This is exactly how the test suite works.

### Minimal example

```javascript
import { createClient } from 'redis';
import { createRESPlite } from 'resplite/embed';

const srv = await createRESPlite({ db: './my-app.db' });
const client = createClient({ socket: { port: srv.port, host: '127.0.0.1' } });
await client.connect();

await client.set('hello', 'world');
console.log(await client.get('hello'));  // → "world"

await client.quit();
await srv.close();
```

### Strings, TTL, and key operations

```javascript
// SET with expiration
await client.set('session:abc', JSON.stringify({ user: 'alice' }));
await client.expire('session:abc', 3600);       // expire in 1 hour
console.log(await client.ttl('session:abc'));     // → 3600 (approx)

// Atomic counters
await client.set('visits', '0');
await client.incr('visits');
await client.incrBy('visits', 10);
console.log(await client.get('visits'));          // → "11"

// Multi-key operations
await client.mSet(['k1', 'v1', 'k2', 'v2']);
const values = await client.mGet(['k1', 'k2', 'missing']);
console.log(values);  // → ["v1", "v2", null]

// Key existence and deletion
console.log(await client.exists('k1'));           // → 1
await client.del('k1');
console.log(await client.exists('k1'));           // → 0
```

### Hashes

```javascript
await client.hSet('user:1', { name: 'Martin', age: '42', city: 'BCN' });

console.log(await client.hGet('user:1', 'name'));   // → "Martin"

const user = await client.hGetAll('user:1');
console.log(user);  // → { name: "Martin", age: "42", city: "BCN" }

await client.hIncrBy('user:1', 'age', 1);
console.log(await client.hGet('user:1', 'age'));     // → "43"

console.log(await client.hExists('user:1', 'email')); // → false
```

### Sets

```javascript
await client.sAdd('tags', ['node', 'sqlite', 'redis']);
console.log(await client.sMembers('tags'));          // → ["node", "sqlite", "redis"]
console.log(await client.sIsMember('tags', 'node')); // → true
console.log(await client.sCard('tags'));              // → 3

await client.sRem('tags', 'redis');
console.log(await client.sCard('tags'));              // → 2
```

### Lists

```javascript
await client.lPush('queue', ['c', 'b', 'a']);        // push left: a, b, c
await client.rPush('queue', ['d', 'e']);              // push right: d, e

console.log(await client.lLen('queue'));               // → 5
console.log(await client.lRange('queue', 0, -1));      // → ["a", "b", "c", "d", "e"]
console.log(await client.lIndex('queue', 0));          // → "a"

console.log(await client.lPop('queue'));               // → "a"
console.log(await client.rPop('queue'));               // → "e"
```

### Sorted sets

```javascript
await client.zAdd('leaderboard', [
  { score: 100, value: 'alice' },
  { score: 250, value: 'bob' },
  { score: 175, value: 'carol' },
]);

console.log(await client.zCard('leaderboard'));                // → 3
console.log(await client.zScore('leaderboard', 'bob'));        // → 250
console.log(await client.zRange('leaderboard', 0, -1));        // → ["alice", "carol", "bob"]
console.log(await client.zRangeByScore('leaderboard', 100, 200)); // → ["alice", "carol"]
```

### Full-text search (RediSearch-like)

```javascript
// Create an index
await client.sendCommand(['FT.CREATE', 'articles', 'SCHEMA', 'payload', 'TEXT']);

// Add documents
await client.sendCommand([
  'FT.ADD', 'articles', 'doc:1', '1', 'REPLACE', 'FIELDS',
  'payload', 'Introduction to SQLite full-text search'
]);
await client.sendCommand([
  'FT.ADD', 'articles', 'doc:2', '1', 'REPLACE', 'FIELDS',
  'payload', 'Building a Redis-compatible server in Node.js'
]);

// Search
const results = await client.sendCommand([
  'FT.SEARCH', 'articles', 'SQLite', 'NOCONTENT', 'LIMIT', '0', '10'
]);
console.log(results);  // → [1, "doc:1"]  (count + matching doc IDs)

// Autocomplete suggestions
await client.sendCommand(['FT.SUGADD', 'articles', 'sqlite full-text', '10']);
await client.sendCommand(['FT.SUGADD', 'articles', 'sqlite indexing', '5']);
const suggestions = await client.sendCommand(['FT.SUGGET', 'articles', 'sqlite']);
console.log(suggestions);  // → ["sqlite full-text", "sqlite indexing"]
```

### Introspection and admin

```javascript
// Scan keys (cursor-based)
const scanResult = await client.scan(0);
console.log(scanResult);  // → { cursor: 0, keys: [...] }

// Key type
console.log(await client.type('user:1'));  // → "hash"

// Admin commands (via sendCommand)
const sqliteInfo = await client.sendCommand(['SQLITE.INFO']);
const cacheInfo  = await client.sendCommand(['CACHE.INFO']);
const memInfo    = await client.sendCommand(['MEMORY.INFO']);
```

### Data persists across restarts

```javascript
import { createClient } from 'redis';
import { createRESPlite } from 'resplite/embed';

const DB_PATH = './persistent.db';

// --- First session: write data ---
const srv1 = await createRESPlite({ db: DB_PATH });
const c1 = createClient({ socket: { port: srv1.port, host: '127.0.0.1' } });
await c1.connect();
await c1.set('persistent_key', 'survives restart');
await c1.hSet('user:1', { name: 'Alice' });
await c1.quit();
await srv1.close();

// --- Second session: data is still there ---
const srv2 = await createRESPlite({ db: DB_PATH });
const c2 = createClient({ socket: { port: srv2.port, host: '127.0.0.1' } });
await c2.connect();
console.log(await c2.get('persistent_key'));     // → "survives restart"
console.log(await c2.hGet('user:1', 'name'));    // → "Alice"
await c2.quit();
await srv2.close();
```

## Compatibility matrix

### Supported (v1)

| Category | Commands |
|---|---|
| **Connection** | PING, ECHO, QUIT |
| **Strings** | GET, SET, MGET, MSET, DEL, EXISTS, INCR, DECR, INCRBY, DECRBY |
| **TTL** | EXPIRE, PEXPIRE, TTL, PTTL, PERSIST |
| **Hashes** | HSET, HGET, HMGET, HGETALL, HDEL, HEXISTS, HINCRBY |
| **Sets** | SADD, SREM, SMEMBERS, SISMEMBER, SCARD |
| **Lists** | LPUSH, RPUSH, LLEN, LRANGE, LINDEX, LPOP, RPOP |
| **Sorted sets** | ZADD, ZREM, ZCARD, ZSCORE, ZRANGE, ZRANGEBYSCORE |
| **Search (FT.\*)** | FT.CREATE, FT.INFO, FT.ADD, FT.DEL, FT.SEARCH, FT.SUGADD, FT.SUGGET, FT.SUGDEL |
| **Introspection** | TYPE, SCAN |
| **Admin** | SQLITE.INFO, CACHE.INFO, MEMORY.INFO |
| **Tooling** | Redis import CLI (see Migration from Redis) |

### Not supported (v1)

- Pub/Sub (SUBSCRIBE, PUBLISH, etc.)
- Streams (XADD, XRANGE, etc.)
- Lua (EVAL, EVALSHA)
- Transactions (MULTI, EXEC, WATCH)
- Blocking commands (BLPOP, etc.)
- SELECT (multiple logical DBs)

Unsupported commands return: `ERR command not supported yet`.

## Migration from Redis

An external CLI imports data from a running Redis instance into a RESPlite SQLite DB. Supports strings, hashes, sets, lists, zsets, and TTL. Requires a local or remote Redis and the `redis` npm package (dev dependency).

```bash
# Default: redis://127.0.0.1:6379 → ./data.db
npm run import-from-redis -- --db ./migrated.db

# Custom Redis URL
npm run import-from-redis -- --db ./migrated.db --redis-url redis://127.0.0.1:6379

# Or host/port
npm run import-from-redis -- --db ./migrated.db --host 127.0.0.1 --port 6379

# Optional: PRAGMA template for the target DB
npm run import-from-redis -- --db ./migrated.db --pragma-template performance
```

Then start RESPLite with the migrated DB: `RESPLITE_DB=./migrated.db npm start`.

## Benchmark (Redis vs RESPLite)

Compare throughput of local Redis and RESPLite with the same workload (PING, SET/GET, hashes, sets, lists, zsets, etc.):

```bash
# Terminal 1: Redis on 6379 (default). Terminal 2: RESPLite on 6380
RESPLITE_PORT=6380 npm start

# Terminal 3: run benchmark (Redis=6379, RESPLite=6380 by default)
npm run benchmark

# Optional: custom iterations and ports
npm run benchmark -- --iterations 10000 --redis-port 6379 --resplite-port 6380
```

## Scripts

| Script | Description |
|---|---|
| `npm start` | Run the server |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests |
| `npm run test:integration` | Integration tests |
| `npm run test:contract` | Contract tests (redis client) |
| `npm run test:stress` | Stress tests |
| `npm run benchmark` | Comparative benchmark Redis vs RESPLite |
| `npm run import-from-redis` | Import from Redis into a SQLite DB |

## Specification

See [SPEC.md](SPEC.md) for the full specification.
