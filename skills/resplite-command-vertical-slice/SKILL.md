---
name: resplite-command-vertical-slice
description: Implements or extends a Redis-like command in RESPLite from spec to docs and tests. Use when the user says "add a command", "support a Redis option", "fix command compatibility", "implement ZRANGE behavior", or "update the compatibility matrix". Do not use for migration-only or FT-only work unless the change also affects the general command surface.
license: MIT
metadata:
  author: Cursor Agent
  version: 1.0.0
  category: workflow-automation
  tags: [resplite, redis-compatibility, commands, tests]
---

# RESPLite Command Vertical Slice

Use this skill when a task requires changing RESPLite's public command behavior end to end rather than only editing one isolated function.

## Use cases

**Use Case: Add a missing command**
Trigger: "implement command X", "add Redis compatibility for X", "support command Y"
Steps: inspect spec and current support, wire the handler, update engine or storage if needed, add tests, update docs
Result: a verified command slice that works through RESP and is reflected in the public docs

**Use Case: Extend a partially supported command**
Trigger: "support another ZRANGE option", "fix TTL edge case", "match Redis error behavior"
Steps: compare current implementation with intended semantics, patch the smallest layer that owns the behavior, strengthen tests, update compatibility notes
Result: improved compatibility without widening scope unnecessarily

**Use Case: Audit a command regression**
Trigger: "this command broke", "redis-cli behaves differently", "wrongtype or ERR output is wrong"
Steps: reproduce through tests, isolate whether the issue is parser, handler, engine, or storage, fix the owning layer, verify client-facing behavior
Result: the bug is fixed with regression coverage

## Instructions

### Step 1: Lock the compatibility target

Start by defining the exact command surface you are changing:

- command name and sub-options
- expected success reply shape
- expected error strings
- whether the change is Redis-standard behavior or RESPLite-specific behavior

Favor the smallest compatibility increment that solves the user's request. RESPLite is intentionally a practical subset, not a full Redis clone.

### Step 2: Review the canonical sources first

Read these files before editing:

- `spec/SPEC_A.md` for scope, positioning, binary-safety expectations, and command boundaries
- `README.md` for the public compatibility matrix and examples
- `src/commands/registry.js` for command dispatch and handler registration

Then inspect the command-specific implementation:

- `src/commands/*.js` for argument parsing and command-level behavior
- `src/engine/*.js` when semantics belong to the engine
- `src/storage/sqlite/*.js` when persistence or query behavior changes
- relevant tests in `test/unit`, `test/integration`, and `test/contract`

### Step 3: Choose the owning layer

Use this decision rule:

- parser or command syntax issue: fix the command handler
- business semantics issue: fix the engine layer
- persistence or query issue: fix SQLite storage helpers
- public support surface changed: also update `README.md` and, if needed, the spec

Avoid scattering logic across layers when one layer can own it cleanly.

### Step 4: Implement the smallest vertical slice

Typical command workflow:

1. Add or update the handler in `src/commands`
2. Register it in `src/commands/registry.js` if needed
3. Patch engine or storage behavior only where required
4. Preserve existing error style such as `ERR ...` and wrong-type behavior
5. Keep binary-safety expectations in mind when keys or values pass through buffers and SQLite

If a new command expands publicly supported behavior, update the compatibility matrix in `README.md`.

### Step 5: Prove it through the right test level

Pick the smallest test mix that proves the change:

- `test/unit/*.test.js` for pure logic, engine rules, parser behavior, or storage helpers
- `test/integration/*.test.js` for end-to-end RESP behavior through the server
- `test/contract/*.test.js` when compatibility with `redis` client or `redis-cli` is part of the user-facing promise

Prefer adding a regression test that would fail before the fix and pass after it.

### Step 6: Report the outcome clearly

When you finish, summarize:

- what compatibility surface changed
- which layers were touched
- which tests were run
- any remaining intentional gaps versus Redis

## RESPLite-specific checklist

- Keep scope aligned with "practical Redis compatibility", not total parity
- Preserve RESP2-facing behavior
- Use the public docs to reflect newly supported behavior
- Do not claim support in docs until tests back it up
- If the command is intentionally unsupported, return the project's clear unsupported-command behavior instead of faking partial support

## Examples

**Example 1: Add a missing command**
User says: "Implement a minimal `ZRANK` command."
Actions: review `spec/SPEC_A.md`, inspect zset handlers and storage helpers, add `src/commands/zrank.js`, register it, add unit and integration coverage, update `README.md` only if support becomes public
Result: one new command works end to end with verified semantics

**Example 2: Fix a compatibility edge case**
User says: "Make `TTL` return the right value for missing keys."
Actions: inspect existing TTL tests, patch the owning logic, add a regression test, verify no unrelated TTL behavior changed
Result: client-visible compatibility improves with minimal code churn

## Troubleshooting

**Problem: The handler exists but the command still returns unsupported**
Cause: `src/commands/registry.js` was not updated, or the command name casing does not match dispatch behavior.
Solution: register the handler in uppercase form and verify the RESP command path through an integration test.

**Problem: The command works in unit tests but not through clients**
Cause: only internal logic was tested; RESP parsing, argument shape, or connection handling may differ.
Solution: add an integration test, and add a contract test if `redis-cli` or the official `redis` client is part of the promise.

**Problem: The change feels larger than one command**
Cause: the request may actually be a search feature or migration flow change rather than a generic command extension.
Solution: switch to the more specific RESPLite skill for migration or `FT.*` work instead of forcing everything into one command slice.
