# Appendix E: Blocking Commands Specification (vNext)

## E.1 Goals

* Support Redis-style blocking behavior for list pop operations over RESP2.
* Provide correct wakeup semantics when data becomes available.
* Avoid busy-waiting; use an internal wait-notify mechanism.
* Ensure atomicity between a push and the unblock of one or more waiters.
* Keep implementation compatible with a single-node, SQLite-backed architecture.

## E.2 Non-Goals (v1 of blocking)

* Distributed blocking semantics across processes.
* Pub/Sub integration.
* Blocking variants that move elements between lists (`BRPOPLPUSH`, `BLMOVE`) unless explicitly added later.
* Fairness guarantees identical to Redis under all corner cases (but we will implement a reasonable fairness policy).

## E.3 Supported Commands (Blocking v1)

* `BLPOP key [key ...] timeout`
* `BRPOP key [key ...] timeout`

**Not supported initially**

* `BRPOPLPUSH`, `BLMOVE`
* Stream blocking (`XREAD BLOCK`)
* Blocking sorted set pops (`BZPOPMIN/BZPOPMAX`) (see E.12 for future extension)

## E.4 Semantics Overview

### E.4.1 Timeout

* `timeout` is in seconds (integer).
* `timeout = 0` means block indefinitely.
* `timeout > 0` means block up to that many seconds.

### E.4.2 Return values

* On success: array of two bulk strings: `[key, element]`
* On timeout: `nil` (Null Bulk String) for RESP2

### E.4.3 Key scanning order

* Keys are checked in the order provided in the command.
* If multiple keys have available elements, the first key in the list wins.

### E.4.4 Wrong type

If a key exists but is not a list:

* return `WRONGTYPE Operation against a key holding the wrong kind of value`

### E.4.5 Interaction with TTL

* Lazy expiration must be applied before checking availability:

  * An expired list key is treated as non-existent.
* Blocking does not “keep alive” a TTL.
* If a key expires while a client is blocked waiting on it, it is treated as missing until a future push recreates it.

## E.5 Data Model Dependency

Blocking commands depend on the list storage model from Appendix B:

* `redis_keys` with `type = list`
* `redis_list_meta`
* `redis_list_items`

## E.6 Internal Waiting Model (Server-side)

Blocking is implemented in memory in the server process.

### E.6.1 Waiter structure

A waiter represents a blocked connection awaiting data from one of several keys.

Required fields:

* connection identifier
* command kind: `BLPOP` or `BRPOP`
* list of keys (ordered)
* deadline (monotonic time) or “infinite”
* per-waiter completion promise/callback
* canceled flag (set on disconnect)

### E.6.2 Wait queues

Maintain in-memory wait queues by key:

* `waitersByKey: Map<keyBytes, Deque<WaiterRef>>`

Each waiter is inserted into the queue for every key it is watching.
Implementation must avoid double-delivery; see E.9.

### E.6.3 Cancellation

If a blocked client disconnects:

* mark waiter canceled
* remove from all `waitersByKey` queues (best-effort; lazy cleanup acceptable if you can skip canceled waiters)

## E.7 Execution Flow

### E.7.1 BLPOP/BRPOP immediate attempt

When `BLPOP/BRPOP` is received:

1. Validate arguments.
2. Apply lazy-expire checks for each key while scanning.
3. For each key in order:

   * attempt non-blocking `LPOP` (for BLPOP) or `RPOP` (for BRPOP) with count=1
   * if an element is returned:

     * respond immediately `[key, element]`
     * do not block
4. If no element found:

   * if `timeout < 0`: error
   * else register waiter and block.

### E.7.2 Blocking registration

* Create waiter with keys list and deadline.
* Add waiter reference to `waitersByKey` for each key.
* Set a timer if timeout > 0.

### E.7.3 Timeout handling

When timeout fires:

* if waiter already completed, do nothing
* else:

  * mark as completed/canceled
  * remove from queues
  * respond `nil`

## E.8 Wakeup Trigger Points

Wakeups occur when a command potentially makes list elements available:

* `LPUSH`
* `RPUSH`

Optional future wakeups:

* `LINSERT`, `LSET` if you implement them and they can create availability (usually not relevant)

## E.9 Atomicity and Delivery Rules

### E.9.1 Single delivery guarantee

A single waiter must complete at most once, even if registered on multiple keys.

Implementation rule:

* Waiter has `completed` boolean.
* On wake attempt, check and set `completed` atomically (in JS: synchronous critical section).

### E.9.2 Key-level fairness policy (recommended)

When a push occurs on key `K`:

* wake the oldest waiter in `waitersByKey[K]` that is not canceled/completed.
* After completing it, stop (one element wakes one waiter).

This yields FIFO fairness per key.

### E.9.3 Cross-key ordering policy

A waiter waiting on multiple keys:

* must receive the first available key according to the provided key order.
* However, the wakeup is triggered by a specific key’s push.
* To preserve key order semantics, on wake attempt:

  1. re-scan the waiter’s key list in order and attempt pop from the first non-empty key.
  2. If pop succeeds, return that key+value.
  3. If pop fails (race, emptied), keep waiting unless a timeout triggers.

This matches Redis behavior more closely than simply popping from the key that triggered the wake.

### E.9.4 SQLite transaction boundary

To ensure correct behavior under concurrent clients:

* Push operations should:

  1. write to SQLite in a transaction
  2. commit
  3. then run wakeup logic

Rationale:

* Waiters that wake and pop must see committed data.
* The pop on wake must be executed in its own transaction (or reuse a controlled engine method that is atomic).

## E.10 Implementation Notes for Performance

* Do not wake all waiters on each push; wake at most a small number (usually 1).
* Use deques for queues to keep O(1) enqueue/dequeue.
* Avoid per-waiter per-key removal work if expensive; allow lazy cleanup by skipping canceled/completed waiters when dequeuing.

## E.11 RESP2 Response Encoding

* Success: RESP Array of 2 Bulk Strings
* Timeout: Null Bulk String (`$-1\r\n`)
* Errors: standard RESP error with messages:

  * `ERR syntax error`
  * `ERR timeout is not an integer or out of range`
  * `WRONGTYPE ...`

## E.12 Future Extension: Blocking ZSET pops

If later adding:

* `BZPOPMIN key [key ...] timeout`
* `BZPOPMAX key [key ...] timeout`

Semantics:

* returns `[key, member, score]` on success
* returns `nil` on timeout
* wake triggers: `ZADD` on watched keys
* delivery: wake oldest waiter; on wake attempt scan keys in order; pop min/max from first available key using indexed query.

Data model already supports efficient min/max via index on `(key, score, member)`.

## E.13 Required Tests (Blocking)

### E.13.1 Happy path

* BLPOP blocks, then returns after RPUSH/LPUSH
* BRPOP blocks, then returns after RPUSH/LPUSH (pops correct end)

### E.13.2 Timeout

* BLPOP with timeout returns nil after timeout
* BRPOP with timeout returns nil after timeout
* timeout=0 blocks indefinitely (test with external trigger then release)

### E.13.3 Multi-key order

* `BLPOP k1 k2 0` with element pushed to k2 first and k1 later:

  * If k2 becomes available first, it should return k2 element (because k1 was empty at that time).
* If both become available, the first in key order should win at wake time.

### E.13.4 Fairness

* Two clients blocked on same key:

  * first blocked must receive first pushed element (FIFO)

### E.13.5 Disconnect cancellation

* Client blocks, disconnects, then push occurs:

  * must not attempt to write to closed socket
  * next waiter should receive element

### E.13.6 TTL interaction

* Client blocks on key with TTL that expires while waiting:

  * should continue waiting and only return when a new push recreates the key
* If key expired, it should not pop phantom items.

### E.13.7 Persistence and restart behavior

* Blocking state does not persist.
* After restart, clients must re-issue blocking commands.

### E.13.8 Concurrency sanity

* Multiple concurrent pushers and blockers:

  * no double delivery
  * no lost items (unless popped by someone else)
  * list meta remains consistent

---

## E.14 Configuration (Recommended)

Add optional server config:

* `blocking.maxWaitersPerKey` (default: 10000)
* `blocking.maxTotalWaiters` (default: 50000)
* `blocking.maxKeysPerWait` (default: 128)
* `blocking.wakeupBatchSize` (default: 1)

If limits are exceeded:

* return `-ERR too many blocked clients` or similar.
