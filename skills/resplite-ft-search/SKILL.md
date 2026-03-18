---
name: resplite-ft-search
description: Builds or refines RESPLite `FT.*` behavior and RediSearch migration mapping on top of SQLite FTS5. Use when the user says "add FT command support", "fix FT.SEARCH", "adjust SQLite FTS5 behavior", "migrate RediSearch indices", or "work on FT.CREATE or FT.ADD semantics". Do not use for unrelated command work outside the search surface.
metadata:
  category: workflow-automation
  tags: [resplite, search, redisearch, sqlite, fts5]
---

# RESPLite FT Search Workbench

Use this skill for search-specific work where RediSearch-inspired behavior must stay grounded in what maps naturally to SQLite FTS5.

## Use cases

**Use Case: Add or refine an `FT.*` command**
Trigger: "implement FT command", "fix FT.SEARCH output", "support another FT option"
Steps: inspect the FT spec, trace command handler to SQLite search helpers, patch the narrowest layer, add unit and integration coverage, update docs if public behavior changed
Result: search behavior improves without pretending to support the full RediSearch surface

**Use Case: Work on index storage or ranking**
Trigger: "change FTS5 schema", "fix BM25 ordering", "debug search index behavior"
Steps: inspect per-index tables and search helpers, patch FTS mapping or metadata behavior, verify with search-focused tests
Result: SQLite-backed search behavior remains internally consistent and externally predictable

**Use Case: Improve RediSearch migration**
Trigger: "migrate FT indices", "map FT.INFO attributes", "handle TAG or NUMERIC fields"
Steps: inspect search migration mapping, keep support boundaries explicit, warn on downgraded or skipped fields, verify with unit tests
Result: migration is useful and honest about current limits

## Instructions

### Step 1: Start with the explicit search scope

Read these first:

- `spec/SPEC_D.md`
- `src/storage/sqlite/search.js`
- `src/commands/ft-create.js`
- `src/commands/ft-add.js`
- `src/commands/ft-search.js`
- `src/migration/migrate-search.js` when migration is involved

Then inspect the relevant tests:

- `test/unit/search.test.js`
- `test/integration/search.test.js`
- `test/unit/ft-parser.test.js`
- `test/unit/migrate-search.test.js`

### Step 2: Preserve RESPLite's search philosophy

Keep these design constraints visible while you work:

- search is RediSearch-inspired, not RediSearch-complete
- the implementation should feel natural for SQLite FTS5
- unsupported behavior should be explicit rather than approximated badly
- public docs should not overstate feature parity

If a requested feature requires excessive gymnastics or breaks the current storage model, prefer a scoped implementation or a clear unsupported response.

### Step 3: Change the correct layer

Use this split:

- syntax and RESP command shape: `src/commands/ft-*.js`
- index metadata, tables, search queries, suggestions: `src/storage/sqlite/search.js`
- migration from a source RediSearch instance: `src/migration/migrate-search.js`

Try not to duplicate validation rules across layers unless that duplication protects a stable public contract.

### Step 4: Keep storage and public behavior aligned

When you modify index or query behavior, verify these invariants:

- index names and field names stay validated
- supported field types are still explicit
- document insert or replace behavior remains atomic
- search result ordering still matches the chosen ranking rules
- docs and migration warnings reflect the real support level

If you widen support, also update `README.md` where the FT surface is described.

### Step 5: Test the exact path you changed

Use the narrowest relevant set:

- parser tests for argument and syntax behavior
- search unit tests for index helpers, query validation, ranking, and suggestion storage
- integration tests for RESP-facing `FT.*` behavior
- `migrate-search` tests for RediSearch compatibility and downgrade warnings

Prefer regression tests that capture the exact failure mode instead of broad smoke coverage only.

### Step 6: Close with support boundaries

Report:

- what `FT.*` behavior changed
- whether the change affects runtime search, migration, or both
- what remains intentionally unsupported
- which tests prove the new behavior

## RESPLite-specific checklist

- Keep the search surface consistent with `spec/SPEC_D.md`
- Do not imply full RediSearch parity
- Preserve the SQLite-first data model
- Keep migration warnings informative when mapping unsupported field types
- Update docs when public support changes

## Examples

**Example 1: Fix `FT.SEARCH` behavior**
User says: "Make `FT.SEARCH` reject invalid query characters consistently."
Actions: inspect query validation in `src/storage/sqlite/search.js`, add a regression test in `test/unit/search.test.js`, run search integration coverage if the RESP result changes
Result: search input validation is stricter and reproducible

**Example 2: Improve RediSearch migration mapping**
User says: "Map `NUMERIC` fields into the current schema as text and emit warnings."
Actions: inspect `src/migration/migrate-search.js` and `test/unit/migrate-search.test.js`, preserve current support boundaries, update tests to prove the downgrade behavior
Result: migration becomes more practical without claiming unsupported range-query semantics

## Troubleshooting

**Problem: The feature request sounds like full RediSearch parity**
Cause: the requested behavior exceeds the current SQLite-first scope.
Solution: narrow the request to the subset that maps naturally to FTS5, document the unsupported parts, and avoid shipping misleading compatibility claims.

**Problem: Search tests pass but migration still breaks**
Cause: runtime `FT.*` behavior and migration mapping are separate code paths.
Solution: verify both `src/storage/sqlite/search.js` and `src/migration/migrate-search.js`, then run both search and migrate-search tests.

**Problem: Delete behavior or row mapping becomes inconsistent**
Cause: index storage invariants were changed without preserving the doc to row mapping assumptions.
Solution: review the per-index tables and their relationships in `src/storage/sqlite/search.js`, then add a focused regression test before expanding the change.
