# RESPLite Specification v1 — Data Model, TTL, and Transactions

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
- `updated_at` supports observability and future maintenance tasks; also used by `OBJECT IDLETIME` (time since last write)

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
