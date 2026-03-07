# RESPLite Specification v1 — Migration Strategy (Core)

## 26. Migration Strategy from Redis

Migration is not part of the RESP protocol surface in v1.
It should be implemented as a programmatic module outside the RESP command surface.

### 26.1 Initial migration method

Recommended initial approach:

- connect to a real Redis instance
- iterate keys using `SCAN`
- discover key type with `TYPE`
- fetch values according to type
- fetch expiration using `PTTL`
- write translated data into SQLite

### 26.2 Initial migratable subset

The initial migration module should support:

- strings
- hashes
- sets
- TTL metadata

### 26.3 Not required initially

- RDB parsing
- AOF parsing
- mirror mode
- dual-write migration

These can be considered later if adoption demands them.

---

## 27. Compatibility Matrix Guidance

The README should include a compatibility matrix with at least three groups:

### Supported

All commands implemented in v1 (and any extensions such as lists, zsets, FT.*, blocking, migration API).

### Planned

Future near-term commands or features as documented in the respective spec files.

### Not Supported

Features explicitly excluded from the roadmap for now, such as:

- Pub/Sub
- Streams
- Lua
- Cluster
- Replication
- Blocking commands (unless added per blocking spec)

This matrix is essential for setting correct user expectations.

---

## 28. Final Design Rule

A command should only be added if its implementation is:

- natural on SQLite
- semantically clear
- testable
- operationally safe
- maintainable without excessive special handling

If a command requires too much implementation gymnastics to preserve Redis-like behavior, it should not be part of the supported surface until a clean design exists.

This rule is central to the project.
It protects correctness, keeps the scope honest, and preserves the identity of RESPLite as a practical Redis-compatible server built on top of SQLite rather than a fragile imitation.
