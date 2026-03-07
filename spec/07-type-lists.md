# RESPLite — Type: Lists (Appendix B)

## B.1 Goals

* Provide Redis-compatible LIST commands over RESP2, backed by SQLite persistence.
* Avoid O(n) reindexing for push/pop operations.
* Support binary-safe values (`Buffer`) and keys as `BLOB`.
* Maintain correct Redis semantics for empty lists and wrong-type errors.

## B.2 Supported Commands (vNext)

* `LPUSH key value [value ...]`
* `RPUSH key value [value ...]`
* `LPOP key [count]`
* `RPOP key [count]`
* `LLEN key`
* `LRANGE key start stop`
* `LINDEX key index` (optional, recommended)
* `LSET key index value` (optional, later)
* `LTRIM key start stop` (optional, later)

**Not supported initially**

* Blocking commands: `BLPOP`, `BRPOP`, `BRPOPLPUSH`
* `RPOPLPUSH`, `LMOVE` (later if needed)

## B.3 Redis Semantics

* **Wrong type:** If `key` exists and is not a list, return:

  * `WRONGTYPE Operation against a key holding the wrong kind of value`
* **Non-existent key:**

  * `LLEN` returns `0`
  * `LRANGE` returns empty array
  * `LPOP/RPOP` returns `nil` (or empty array for count > 1)
* **Empty list after removals:** When a list becomes empty, delete the logical key:

  * delete metadata from `redis_keys`
  * delete list meta/items rows

## B.4 Data Model (SQLite)

Lists are stored using a monotonic sequence strategy per key to avoid shifting indices.

### B.4.1 Metadata table

```sql
CREATE TABLE redis_list_meta (
  key BLOB PRIMARY KEY,
  head_seq INTEGER NOT NULL,
  tail_seq INTEGER NOT NULL,
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);
```

**Invariant:**

* Empty list should not exist (no meta row). If it exists, it must satisfy `head_seq <= tail_seq`.

### B.4.2 Items table

```sql
CREATE TABLE redis_list_items (
  key BLOB NOT NULL,
  seq INTEGER NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (key, seq),
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);

CREATE INDEX redis_list_items_key_seq_idx ON redis_list_items(key, seq);
```

## B.5 Sequence Strategy

* Each list key maintains:

  * `head_seq`: the smallest sequence currently used (front)
  * `tail_seq`: the largest sequence currently used (back)
* For a new list:

  * initialize `head_seq = 0`, `tail_seq = -1` (or similar empty sentinel)
  * but we recommend **not creating meta** until first push.

### Push operations

* `LPUSH`:

  * decrement `head_seq` and insert new items at `seq = head_seq - 1` per pushed element
* `RPUSH`:

  * increment `tail_seq` and insert new items at `seq = tail_seq + 1`

Maintain ordering:

* front is smaller `seq`, back is larger `seq`.

## B.6 Command Behavior

### B.6.1 LPUSH

**Request:** `LPUSH key v1 v2 ...`
**Response:** Integer = new list length

Implementation notes:

* If key does not exist: create `redis_keys` type list + create `redis_list_meta`.
* Insert values in left-push order consistent with Redis:

  * `LPUSH mylist a b c` results in list `[c, b, a]` at the head.
* Use a single transaction:

  * ensure type
  * upsert meta
  * insert items
  * bump `redis_keys.version`, update `updated_at`

### B.6.2 RPUSH

Same structure, response is new length.

### B.6.3 LLEN

Return length:

* If key not exist: `0`
* Else length = `tail_seq - head_seq + 1` (derived from meta)
* Do not count rows for performance.

### B.6.4 LPOP / RPOP

* Without `count`: return bulk string or `nil`
* With `count`:

  * Redis returns array of popped elements
  * If list has fewer than count: return all available
  * If key does not exist: return `nil` for no-count, or empty array for count
* After popping last element: delete key and meta.

**Implementation:**

* In a transaction:

  * read meta
  * compute seq range to remove
  * select values for response
  * delete those rows
  * update meta head/tail accordingly
  * if empty -> delete key meta entirely

### B.6.5 LRANGE

`LRANGE key start stop` returns array of elements.

Index rules (Redis):

* `start` and `stop` are inclusive.
* Negative indices count from end (`-1` is last element).
* Clamp indices to valid bounds.
* If start > stop after normalization: empty array.

**Mapping indices to sequences:**

* Let `len = tail_seq - head_seq + 1`
* Normalize start/stop into `[0..len-1]`
* Convert to seq:

  * `seq_start = head_seq + start`
  * `seq_stop  = head_seq + stop`
* SQL:

  * `SELECT value FROM redis_list_items WHERE key=? AND seq BETWEEN ? AND ? ORDER BY seq ASC`

## B.7 Expiration and Cache

* TTL is stored in `redis_keys.expires_at`, same as other types.
* Lazy expiration must delete list meta/items like other types.
* Cache strategy (recommended):

  * Cache small lists (len <= configured threshold) optionally.
  * Otherwise cache only meta (`head_seq`, `tail_seq`) if beneficial.
  * Always invalidate on list writes.

## B.8 Complexity Targets

* `LPUSH/RPUSH`: O(k) inserts, no reindexing
* `LPOP/RPOP`: O(k) deletes + selects for return
* `LLEN`: O(1)
* `LRANGE`: O(n) in returned range

## B.9 Tests (Required)

For each command above:

* Happy path
* Non-existent key behavior
* Wrong-type behavior
* TTL interaction (expires then acts as missing)
* Persistence across restart
* Binary safety for values
* Concurrency sanity (multiple clients pushing/popping does not corrupt meta)
