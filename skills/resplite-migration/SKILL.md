---
name: resplite-migration
description: Guides Redis to RESPLite migration work using the programmatic migration API, dirty-key tracking, cutover, and verification. Use when the user says "migrate Redis", "dirty tracker", "cutover", "resume bulk import", "verify migration", or "move RediSearch data during migration". Do not use for generic command work that does not touch the migration flow.
metadata:
  category: workflow-automation
  tags: [resplite, migration, redis, cutover, verification]
---

# RESPLite Migration Cutover Assistant

Use this skill for migration work where correctness, resumability, and cutover sequencing matter more than raw implementation speed.

## Use cases

**Use Case: Drive a Redis to RESPLite migration**
Trigger: "help me migrate Redis", "create migration script", "plan cutover"
Steps: inspect the migration API, build or adjust a single-script flow, verify preflight, bulk, dirty tracking, cutover, and verification
Result: a reproducible migration workflow with minimal downtime

**Use Case: Fix dirty-key tracking or resumability**
Trigger: "dirty tracker missed keys", "resume is broken", "migration status is wrong"
Steps: inspect registry and tracker logic, reproduce through tests, fix the persistent state transitions, verify cutover semantics
Result: the migration state machine behaves predictably across interruptions

**Use Case: Add or change RediSearch migration behavior**
Trigger: "migrate FT indices", "search migration", "map RediSearch fields"
Steps: review `migrate-search`, map fields to current FT support, verify warnings and skipped cases, test the result with fake Redis or integration coverage
Result: search migration stays aligned with the current FT implementation

## Instructions

### Step 1: Prefer the programmatic API

Start from `resplite/migration`, not from deleted or legacy CLI paths. The current intended entry point is `createMigration()` in `src/migration/index.js`.

Read these sources first:

- `README.md` migration section
- `spec/SPEC_F.md`
- `src/migration/index.js`
- `src/migration/tracker.js`
- `src/migration/migrate-search.js` when `FT.*` is involved

If the requested change conflicts with the documented sequence, treat the documented cutover flow as the source of truth unless the task explicitly updates docs and behavior together.

### Step 2: Keep the real cutover model intact

Model the migration as these phases:

1. `preflight()`
2. `enableKeyspaceNotifications()`
3. `startDirtyTracker()`
4. `bulk({ resume: true })`
5. pause and freeze writes to Redis
6. `applyDirty()`
7. `stopDirtyTracker()`
8. `migrateSearch()` if the source uses `FT.*`
9. `verify()`
10. `close()`

Do not collapse cutover into "bulk then switch" if dirty tracking or write freeze is part of the scenario.

### Step 3: Preserve resumability and persistence semantics

When editing migration internals, make sure these properties stay true:

- bulk progress checkpoints can resume after interruption
- dirty keys are persisted in SQLite
- final cutover uses the last dirty set after writes are frozen
- status can be read from SQLite without Redis being connected

If the source Redis has a renamed `CONFIG` command, keep `configCommand` support working across both preflight and notification setup.

### Step 4: Distinguish KV migration from search migration

Keep these boundaries clear:

- `bulk` and `applyDirty` handle strings, hashes, sets, lists, and zsets
- `migrateSearch()` handles RediSearch schema and document migration separately
- search migration is not a substitute for the dirty-key delta flow

This separation keeps the code and operator workflow predictable.

### Step 5: Verify the exact failure mode

Use the narrowest useful test set:

- `test/integration/migration-dirty-tracker.test.js` for dirty tracking and cutover behavior
- `test/unit/migration-registry.test.js` for persistent registry semantics
- `test/unit/migrate-search.test.js` for RediSearch mapping and migration edge cases

If you change the public script examples or workflow guidance, update `README.md` so the docs and implementation stay in sync.

### Step 6: Report operationally, not just structurally

When closing the task, summarize:

- what phase of the migration flow changed
- whether the change affects operator cutover steps
- what verification was run
- any remaining assumptions about Redis configuration, notifications, or FT availability

## RESPLite-specific checklist

- Use the single-script programmatic flow as the happy path
- Treat the final dirty apply after write freeze as authoritative
- Keep `resume: true` behavior simple and restart-safe
- Preserve the distinction between key migration and search migration
- Update docs when operator-facing behavior changes

## Examples

**Example 1: Fix cutover sequencing**
User says: "The migration docs and code should make the final dirty apply happen only after writes are frozen."
Actions: review `README.md` and `spec/SPEC_F.md`, patch the sequencing if needed, adjust tests, verify the user-facing migration script matches the intended cutover flow
Result: docs, code, and tests describe the same operational sequence

**Example 2: Improve search migration**
User says: "Map RediSearch TAG fields into the current FT implementation with warnings."
Actions: inspect `src/migration/migrate-search.js`, preserve the current FT scope, update unit tests around field mapping, report unsupported field types clearly
Result: migration becomes more helpful without pretending to support unsupported search behavior

## Troubleshooting

**Problem: Dirty tracking appears to miss updates**
Cause: keyspace notifications are not enabled, the tracker was not running during bulk, or the scenario expects durable CDC semantics that Redis notifications do not provide.
Solution: verify `enableKeyspaceNotifications()`, keep the tracker active during bulk, and rely on the final write freeze plus `applyDirty()` for authoritative cutover.

**Problem: Bulk resume logic is confusing**
Cause: code or docs treat first run and resumed run as separate flows.
Solution: keep `resume: true` as the default simple path and make sure the same script works for both start and resume.

**Problem: Search migration is mixed into the key delta**
Cause: the implementation is blurring `migrateSearch()` with key replication semantics.
Solution: keep the keyspace migration and RediSearch migration as separate steps, then verify each with the appropriate tests.
