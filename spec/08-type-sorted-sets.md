# RESPLite — Type: Sorted Sets / ZSET (Appendix C)

## C.1 Goals

* Provide a Redis-compatible subset of ZSET commands with efficient range and score queries.
* Persist in SQLite with appropriate indexing.
* Keep semantics close to Redis for ordering, score ties, and missing elements.

## C.2 Supported Commands (vNext)

Recommended minimal set:

* `ZADD key [NX|XX] [CH] [INCR] score member [score member ...]` (start with a reduced subset)
* `ZREM key member [member ...]`
* `ZCARD key`
* `ZSCORE key member`
* `ZRANGE key start stop [WITHSCORES]`
* `ZREVRANGE key start stop [WITHSCORES]` (optional but useful)
* `ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT offset count]`
* `ZREMRANGEBYSCORE key min max` (optional, later)
* `ZSCAN key cursor [MATCH pattern] [COUNT n]` (later)

**Initial simplification for v1 of ZSET:**

* Support `ZADD key score member [score member ...]` (no flags) returning number of new elements.
* Add flags later.

## C.3 Redis Semantics

* Sorted set is ordered by:

  1. score ascending
  2. member lexicographically ascending as tie-breaker (Redis behavior)
* Wrong type errors same pattern as other types.
* Non-existent key:

  * `ZCARD` => `0`
  * `ZRANGE` => empty array
  * `ZSCORE` => `nil`

## C.4 Data Model (SQLite)

```sql
CREATE TABLE redis_zsets (
  key BLOB NOT NULL,
  member BLOB NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (key, member),
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);

CREATE INDEX redis_zsets_key_score_member_idx
  ON redis_zsets(key, score, member);
```

Notes:

* `PRIMARY KEY (key, member)` allows upsert of member score.
* Secondary index supports score range scans and stable ordering by `(score, member)`.

## C.5 Command Behavior

### C.5.1 ZADD

**Minimal v1 behavior:**

* `ZADD key score member [score member ...]`
* Response: integer count of **new** members added (not updated).
* If key does not exist: create metadata type zset.
* For existing member: update score (does not increment return count).
* Use one transaction:

  * ensure type
  * upsert all pairs
  * bump key version

**Later flags (optional):**

* `NX`: only add new
* `XX`: only update existing
* `CH`: count changed elements
* `INCR`: single member increment

### C.5.2 ZREM

* Remove one or more members.
* Response: integer number removed.
* If zset becomes empty: delete key metadata.

### C.5.3 ZCARD

* Return cardinality:

  * Prefer `SELECT COUNT(*)` (acceptable).
  * If performance needs: maintain count in a meta table (not needed initially).

### C.5.4 ZSCORE

* Return bulk string representing score (Redis returns string form), or `nil`.
* Store as `REAL`, but serialize consistently:

  * Use a stable conversion (avoid scientific notation surprises if possible).
  * Accept that exact formatting may differ from Redis; document if needed.

### C.5.5 ZRANGE (by rank)

**Request:** `ZRANGE key start stop [WITHSCORES]`

Rank rules like LRANGE:

* start/stop inclusive
* negative indexes from end
* clamp

Implementation:

* let `len = ZCARD`
* normalize range
* SQL for ordering:

  ```sql
  SELECT member, score
  FROM redis_zsets
  WHERE key=?
  ORDER BY score ASC, member ASC
  LIMIT ? OFFSET ?;
  ```
* Response:

  * without WITHSCORES: array of members
  * with WITHSCORES: array `[member1, score1, member2, score2, ...]`

### C.5.6 ZRANGEBYSCORE

**Request:** `ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT offset count]`

Score bounds rules:

* Support numeric `min/max`.
* Optional later: `(` exclusive bounds, `-inf`, `+inf`.

Implementation:

```sql
SELECT member, score
FROM redis_zsets
WHERE key=? AND score >= ? AND score <= ?
ORDER BY score ASC, member ASC
LIMIT ? OFFSET ?;
```

Return format same as `ZRANGE`.

## C.6 Expiration and Cache

* TTL is in `redis_keys.expires_at`.
* Lazy expiration removes zset rows via cascade.
* Cache:

  * Cache `ZSCORE` lookups optionally (key+member) if beneficial.
  * Avoid caching full zsets early.
  * Always invalidate on `ZADD/ZREM`.

## C.7 Complexity Targets

* `ZADD`: O(k log n) effectively via index maintenance, practical for SQLite
* `ZRANGE`: O(m) over returned slice with index support
* `ZRANGEBYSCORE`: O(m) over match range with index support
* `ZSCORE`: O(log n) via PK on (key, member)

## C.8 Tests (Required)

* Correct ordering:

  * by score, then by member for ties
* Rank normalization:

  * negative indices
  * out of range
  * start > stop -> empty
* Score range:

  * boundaries inclusive
  * LIMIT behavior
* Wrong type behavior
* TTL interaction and lazy deletion
* Persistence across restart
* Binary member support
* Concurrency sanity:

  * multiple clients doing `ZADD` on same key does not corrupt ordering or counts

---

## Integration notes (LIST and ZSET)

### Type constants

Extend `redis_keys.type` enum:

* `4 = list`
* `5 = zset`

### Wrong-type enforcement

Any command on a key must:

1. run lazy-expire check
2. read `redis_keys.type`
3. if mismatch, return WRONGTYPE

### Key deletion when empty

For list and zset:

* if becomes empty, delete metadata key row (and meta/items rows if any)

### SCAN behavior

* SCAN should include list/zset keys automatically (it reads from `redis_keys`).
