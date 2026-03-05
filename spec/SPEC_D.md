# Appendix D: Search (FT.*) Specification

## D.1 Goals

* Provide a RediSearch-inspired feature set using **SQLite FTS5** with **BM25 ranking**.
* Support the following commands over **RESP2**:

  * `FT.CREATE`
  * `FT.INFO`
  * `FT.ADD`
  * `FT.DEL`
  * `FT.SUGADD`
  * `FT.SUGGET`
  * `FT.SUGDEL`
  * `FT.SEARCH`
* Prioritize correctness and persistence on a single node.
* No distributed indexing, no clustering, no pub/sub.
* Keep implementation “natural” for SQLite (no excessive gymnastics).

## D.2 Non-Goals (v1)

* Full RediSearch query language (filters, TAG fields, numeric fields, geo, highlights, aggregations).
* Full option compatibility for all FT commands.
* Stemming/language analyzers beyond SQLite’s tokenizer capabilities.
* Synonyms, phonetics, advanced scoring models.

---

# D.3 Data Model (SQLite)

Search indexes are stored independently of the Redis-like keyspace. Index metadata is global; each index has its own document storage, FTS table, and suggestion dictionary.

## D.3.1 Global index registry

```sql id="d1y4i2"
CREATE TABLE search_indices (
  name TEXT PRIMARY KEY,
  schema_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

* `schema_json` stores fields, types, and any configuration needed to rebuild the index.

## D.3.2 Per-index tables (created by FT.CREATE)

For an index named `{idx}`, create:

### Documents table

Stores canonical doc metadata and raw fields for retrieval.

```sql id="9gq1cv"
CREATE TABLE search_docs__{idx} (
  doc_id TEXT PRIMARY KEY,
  score REAL NOT NULL DEFAULT 1.0,
  fields_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### FTS5 table (contentless)

Stores only the searchable text columns.

```sql id="l0kqtn"
CREATE VIRTUAL TABLE search_fts__{idx}
USING fts5(
  payload,
  tokenize = 'unicode61',
  content=''
);
```

**Row linkage rule:** `search_fts__{idx}.rowid` must match a stable integer rowid for the document.
Implementation approach:

* Maintain a mapping table from `doc_id` to integer `fts_rowid`.

### DocID ↔ FTS rowid mapping

```sql id="r7x2jv"
CREATE TABLE search_docmap__{idx} (
  doc_id TEXT PRIMARY KEY,
  fts_rowid INTEGER NOT NULL UNIQUE
);
```

### Suggestions table (dictionary)

```sql id="q3m8ap"
CREATE TABLE search_sugs__{idx} (
  term TEXT PRIMARY KEY,
  score REAL NOT NULL,
  payload TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX search_sugs__{idx}_score_idx ON search_sugs__{idx}(score DESC);
```

---

# D.4 FT.CREATE

## D.4.1 Supported syntax (minimal)

Example:

```
FT.CREATE names SCHEMA payload TEXT
```

### Rules

* Index name: ASCII token `[A-Za-z0-9:_-]+`
* Must include `SCHEMA`.
* Supported field type: `TEXT` only (v1).
* At least one field required.
* For v1, require a field named `payload` (recommended) because your FT.ADD example uses `payload`.

## D.4.2 Behavior

* Creates registry row in `search_indices`.
* Creates per-index tables (`search_docs__idx`, `search_fts__idx`, `search_docmap__idx`, `search_sugs__idx`).
* RESP reply: `+OK`

## D.4.3 Errors

* If index already exists: `-ERR index already exists`
* Bad syntax: `-ERR syntax error`

---

# D.5 FT.INFO

## D.5.1 Syntax

```
FT.INFO {index}
```

## D.5.2 Response (RESP2 Array)

Return an array of key/value pairs (simple and stable), for example:

```
1) "index_name"    2) "names"
3) "fields"        4) ["payload"]
5) "num_docs"      6) (integer)
7) "fts_rows"      8) (integer)
9) "num_suggestions" 10) (integer)
11) "created_at"   12) (integer unix ms)
13) "updated_at"   14) (integer unix ms)
```

Exact fields may evolve, but these should exist.

## D.5.3 Errors

* Missing index: `-Unknown index name`

---

# D.6 FT.ADD

## D.6.1 Required syntax (your exact example)

```
FT.ADD {index} {doc_id} {score} [REPLACE] FIELDS {field} {value} [{field} {value} ...]
```

Example:

```
FT.ADD names DY1O2 1 REPLACE FIELDS payload "martin clasen"
```

## D.6.2 Supported options (v1)

* `REPLACE` supported:

  * If doc exists, update fields and score.
  * If doc does not exist, insert.
* `FIELDS` required.
* Only TEXT fields defined in schema are accepted.
* Values can be bulk strings; quoting is handled at RESP layer, not by a textual shell.

## D.6.3 Persistence + transactional behavior

FT.ADD must be **atomic**:

* Upsert into `search_docs__idx`
* Ensure row exists in `search_docmap__idx` (assign `fts_rowid` if new)
* Upsert into `search_fts__idx` using that `rowid`

All within one SQLite transaction.

## D.6.4 FTS content mapping

For each TEXT field, store content in the FTS table.

* v1 minimal: store only `payload` column (recommended).
* If schema includes multiple TEXT fields, create them as FTS columns and store accordingly.

## D.6.5 Return value

RESP reply: `+OK`
(Chosen for best compatibility with older RediSearch expectations.)

## D.6.6 Errors

* Index missing: `-Unknown index name`
* Wrong syntax: `-ERR syntax error`
* Missing `FIELDS`: `-ERR syntax error`
* Unknown field: `-ERR unknown field`
* Score not numeric: `-ERR invalid score`

---

# D.7 FT.DEL

## D.7.1 Syntax

```
FT.DEL {index} {doc_id}
```

## D.7.2 Behavior

* If document exists:

  * delete from `search_docs__idx`
  * delete from `search_docmap__idx`
  * delete from `search_fts__idx` by `rowid`
* If not exist: no-op

All in one transaction.

## D.7.3 Return

RESP Integer:

* `(integer) 1` if deleted
* `(integer) 0` if not found

## D.7.4 Errors

* Index missing: `-Unknown index name`

---

# D.8 FT.SEARCH

## D.8.1 Required syntax (your example)

```
FT.SEARCH {index} {query} [NOCONTENT] [LIMIT {offset} {count}]
```

Example:

```
FT.SEARCH names clasen* NOCONTENT LIMIT 0 25
```

## D.8.2 Query language (v1)

Supported query forms:

* Single term: `clasen`
* Prefix term: `clasen*` (maps to FTS5 prefix query)
* Multiple terms separated by spaces: `martin clasen*`

Not supported (v1):

* Boolean operators, parentheses
* Field scoping (`@field:`)
* Numeric ranges, TAG filters

## D.8.3 Prefix queries

If a token ends with `*`, treat it as a prefix query in FTS5.

Implementation:

* Convert user query into a safe FTS5 `MATCH` expression.
* Example mapping:

  * `clasen*` → `clasen*`
  * `martin clasen*` → `martin clasen*`

You must escape / reject characters that can break the MATCH syntax.

## D.8.4 Ranking (BM25)

* Use SQLite FTS5 ranking: `bm25(search_fts__idx)`
* Final score for sorting:

  * `rank = bm25(...)`
  * Apply doc boost: multiply or additive adjustment with `search_docs__idx.score`
  * Recommended: `final_rank = bm25 * score` (simple)

**Order:** best results first (lower bm25 may mean better depending on SQLite; normalize consistently).
Implementation must define a consistent ordering; document it in code.

## D.8.5 LIMIT

* Default LIMIT if omitted: `LIMIT 0 10`
* Enforce max count (server config), e.g. 1000.

## D.8.6 Response format (RediSearch-style)

### Without NOCONTENT (optional v1.1)

Return:

```
[ total,
  doc_id_1, [field, value, field, value ...],
  doc_id_2, [field, value ...],
  ...
]
```

### With NOCONTENT (required by your example)

Return:

```
[ total, doc_id_1, doc_id_2, ... ]
```

* `total` is the total number of matches (ignoring LIMIT).
* `doc_id_*` are strings.

## D.8.7 Total matches

Compute total efficiently:

* Use a `COUNT(*)` on the match query (can be separate query).
* Or use FTS5 auxiliary count logic if available.
  v1 can do a second query for simplicity.

## D.8.8 Errors

* Index missing: `-Unknown index name`
* Bad syntax: `-ERR syntax error`
* Invalid LIMIT: `-ERR invalid limit`
* Unsafe query: `-ERR invalid query`

---

# D.9 Suggestions (FT.SUG*)

Suggestions are per-index. Commands operate on the suggestion dictionary table `search_sugs__idx`.

## D.9.1 FT.SUGADD

### Syntax

```
FT.SUGADD {index} {string} {score} [INCR] [PAYLOAD {payload}]
```

### v1 behavior

* If term does not exist: insert with given score.
* If term exists:

  * if `INCR`: add score
  * else: replace score
* Store optional `payload` string.

### Return

RESP Integer:

* `(integer) 1` if new term inserted
* `(integer) 0` if updated existing

### Errors

* Index missing: `-Unknown index name`
* Score invalid: `-ERR invalid score`

## D.9.2 FT.SUGGET

### Syntax

```
FT.SUGGET {index} {prefix} [FUZZY] [MAX {n}] [WITHSCORES] [WITHPAYLOADS]
```

### v1 supported subset

Required:

* `{prefix}`
  Optional:
* `MAX n` (default 5)
* `WITHSCORES` (optional)
* `WITHPAYLOADS` (optional)

Not supported (v1):

* `FUZZY` (return `ERR not supported yet` if present)

### Matching rule

* Prefix match on `term`:

  * SQL: `WHERE term LIKE prefix || '%'`
* Order by `score DESC`, then `term ASC`
* Limit to `MAX n`

### Response

* Default: array of terms: `["term1", "term2", ...]`
* With `WITHSCORES`: `["term1", "score1", "term2", "score2", ...]`
* With `WITHPAYLOADS`: `["term1", "payload1", ...]`
* With both: `["term1","score1","payload1","term2","score2","payload2",...]`

### Errors

* Index missing: `-Unknown index name`
* Bad syntax: `-ERR syntax error`

## D.9.3 FT.SUGDEL

### Syntax

```
FT.SUGDEL {index} {string}
```

### Behavior

Delete the term if exists.

### Return

RESP Integer:

* `(integer) 1` if deleted
* `(integer) 0` if not found

### Errors

* Index missing: `-Unknown index name`

---

# D.10 Integration Rules

## D.10.1 Wrong-type model

FT.* indexes are independent. They do not conflict with `redis_keys.type`.
No WRONGTYPE interactions with KV keys are required.

## D.10.2 Expiration

Search indexes and suggestion dictionaries do not inherit TTL from KV keys in v1.

(If later you index hashes from KV keys, then TTL integration becomes relevant. Not in this spec.)

## D.10.3 Binary safety

* `doc_id` is treated as UTF-8 string token (v1).
* Field values are stored as text for FTS5.
* If binary values are passed, behavior is:

  * reject with `-ERR invalid field value` or
  * coerce as UTF-8 if valid
    Choose one and keep it consistent. Recommended: reject invalid UTF-8 for search fields.

---

# D.11 Required Tests for Search

For each command: happy path, missing index, bad syntax.

## FT.CREATE

* creates index tables
* rejects duplicate index

## FT.ADD

* inserts new doc, returns OK
* replace existing doc with REPLACE
* unknown field error
* score parse error
* persistence across restart

## FT.SEARCH

* term search returns expected docs
* prefix search `clasen*` works
* NOCONTENT response shape is correct
* LIMIT offset/count works
* total count correct
* persistence across restart

## FT.DEL

* deletes existing and returns 1
* returns 0 if missing
* persistence across restart

## Suggestions

* SUGADD insert returns 1, update returns 0
* INCR behavior
* SUGGET prefix returns correct order
* WITHSCORES / WITHPAYLOADS shape
* SUGDEL behavior

---

# Appendix D.12: Minimal SQL Generation Template for `FT.CREATE`

## D.12.1 Deterministic naming and sanitization

### Index name constraints

To avoid SQL injection and keep object creation deterministic:

* Accept index names matching:
  `^[A-Za-z][A-Za-z0-9:_-]{0,63}$`
* Reject otherwise with: `-ERR invalid index name`

### Deterministic SQL object naming

Given index name `idx`, derive SQLite object names:

* Docs table: `search_docs__{idx}`
* FTS table:  `search_fts__{idx}`
* Map table:  `search_docmap__{idx}`
* Sugs table: `search_sugs__{idx}`
* Sugs score index: `search_sugs__{idx}_score_idx`

Because SQLite identifiers are not parameterizable, **only permit safe index names** and then interpolate these derived names.

## D.12.2 Minimal supported schema for v1

* Require `SCHEMA payload TEXT`
* Allow additional `TEXT` fields, but only `TEXT` in v1.
* Store schema as JSON in `search_indices.schema_json` with stable ordering.

### Canonical schema JSON format

Always serialize fields sorted by field name:

```json
{
  "version": 1,
  "fields": [
    {"name": "payload", "type": "TEXT"},
    {"name": "title", "type": "TEXT"}
  ],
  "tokenizer": "unicode61"
}
```

This determinism makes `FT.INFO` stable and simplifies migrations.

## D.12.3 SQL template (exact statements)

### Transaction wrapper

`FT.CREATE` must be atomic:

1. insert into registry
2. create per-index tables
3. create indices
4. commit

Use:

* `BEGIN IMMEDIATE;` (preferred for deterministic write-locking)
* `COMMIT;`
* `ROLLBACK;` on error

### Registry insert

```sql id="mfrk5a"
INSERT INTO search_indices(name, schema_json, created_at, updated_at)
VALUES (?, ?, ?, ?);
```

### Create docs table

```sql id="7w8d3q"
CREATE TABLE search_docs__{idx} (
  doc_id TEXT PRIMARY KEY,
  score REAL NOT NULL DEFAULT 1.0,
  fields_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Create doc map table (stable FTS rowid mapping)

```sql id="0bc6xw"
CREATE TABLE search_docmap__{idx} (
  doc_id TEXT PRIMARY KEY,
  fts_rowid INTEGER NOT NULL UNIQUE
);
```

### Create FTS table

FTS columns must match schema field names in canonical order.

If schema fields are `payload`, `title`, `body`, generate:

```sql id="qsx4f3"
CREATE VIRTUAL TABLE search_fts__{idx}
USING fts5(
  payload,
  title,
  body,
  tokenize='unicode61',
  content=''
);
```

Notes:

* Use `content=''` to keep it contentless.
* Use `unicode61` tokenizer for predictable behavior.

### Create suggestions table

```sql id="u3rz8d"
CREATE TABLE search_sugs__{idx} (
  term TEXT PRIMARY KEY,
  score REAL NOT NULL,
  payload TEXT,
  updated_at INTEGER NOT NULL
);
```

### Create suggestions score index

```sql id="xq2dwf"
CREATE INDEX search_sugs__{idx}_score_idx
ON search_sugs__{idx}(score DESC);
```

## D.12.4 Idempotency and error handling

* `FT.CREATE` must fail if the index exists.
* Do not use `IF NOT EXISTS` in `CREATE TABLE` for v1 because it hides partial state problems.
* If creation fails mid-way, transaction rollback must remove the registry insert.
  (Table creation in SQLite auto-commits DDL in some contexts; prefer running all DDL inside a transaction and validate behavior with tests.)

## D.12.5 Validation step after creation

After running the transaction, validate:

* registry row exists
* all tables exist (query `sqlite_master`)
* schema_json is canonical

If validation fails: return `-ERR internal error`

---

# Appendix D.13: Strict Argument Parser Grammar for FT Commands

## D.13.1 Token model

All commands arrive as RESP Arrays. Each element is a Bulk String (bytes). The server must:

* Decode **command tokens** as ASCII/UTF-8 (reject invalid UTF-8 in command keywords).
* Treat **doc_id**, **index**, **field names**, and **options** as UTF-8 strings (reject invalid UTF-8).
* Treat **field values** as UTF-8 strings (reject invalid UTF-8) because FTS requires text.

Binary values are allowed in KV commands, but **not** in FT fields (v1). If invalid UTF-8: `-ERR invalid field value`.

## D.13.2 Common lexical rules

All keywords are case-insensitive but normalized to uppercase.

### IndexName

```
IndexName := /[A-Za-z][A-Za-z0-9:_-]{0,63}/
```

### DocId

```
DocId := 1..256 UTF-8 chars, no NUL
```

### FieldName

```
FieldName := /[A-Za-z][A-Za-z0-9_]{0,63}/
```

### Number

```
Integer := ["-"] DIGIT+
Float   := ["-"] DIGIT+ ["." DIGIT+]
Score   := Integer | Float
```

### QueryToken (v1 safe subset)

For `FT.SEARCH query`:

* allow tokens matching:

  * `/[A-Za-z0-9_]+[*]?/`
* tokens separated by spaces in a single argument string.
* reject characters that can break FTS MATCH, including: `" ' : ( ) [ ] { } \` and non-printable.

If query contains disallowed chars: `-ERR invalid query`

---

## D.13.3 Grammar notation

EBNF-ish. Tokens are RESP array elements unless otherwise specified.

### FT.CREATE

Command:

```
FT.CREATE IndexName (Option)* "SCHEMA" FieldSpec+
Option := (ignored in v1, but must not be accepted silently unless explicitly listed)
FieldSpec := FieldName FieldType
FieldType := "TEXT"
```

Strict rules:

* Must include `SCHEMA`.
* Must have at least one FieldSpec.
* Must include `payload TEXT` in v1 (recommended strict requirement).
* No unknown FieldType.
* No extra trailing tokens.

Errors:

* missing SCHEMA → `-ERR syntax error`
* unknown field type → `-ERR unsupported field type`
* missing payload → `-ERR payload field required`

### FT.INFO

```
FT.INFO IndexName
```

* Exactly 2 tokens (command + index).

### FT.ADD

```
FT.ADD IndexName DocId Score ( "REPLACE" )? "FIELDS" FieldValuePair+
FieldValuePair := FieldName FieldValue
FieldValue := UTF-8 text (may include spaces because it is a single RESP bulk string)
```

Strict rules:

* `FIELDS` is required.
* At least one pair after `FIELDS`.
* Pairs must be even count.
* Every FieldName must be present in schema.
* Score must parse to finite number.
* Only `REPLACE` option is allowed in v1.
* No other options accepted.

Errors:

* missing FIELDS → `-ERR syntax error`
* odd number of field tokens → `-ERR syntax error`
* unknown field → `-ERR unknown field`
* invalid score → `-ERR invalid score`
* doc exists without REPLACE (if you choose strict semantics) → either:

  * `-ERR document exists` (strict), or
  * treat as upsert anyway (recommended for simplicity)
    Choose one and document it; recommended: allow upsert only when REPLACE is present.

### FT.DEL

```
FT.DEL IndexName DocId
```

Return integer 1/0.

### FT.SEARCH

```
FT.SEARCH IndexName Query ( "NOCONTENT" )? ( "LIMIT" Offset Count )?
Offset := Integer (>=0)
Count  := Integer (>=0)
```

Strict rules:

* Query must be present as single token (may include spaces inside because it is a single bulk string).
* At most one `NOCONTENT`.
* At most one `LIMIT`.
* If LIMIT present: must have exactly two integers.
* No other options allowed in v1.

Defaults:

* if LIMIT missing: offset=0 count=10.

Errors:

* bad LIMIT → `-ERR invalid limit`
* unknown option → `-ERR syntax error`
* invalid query chars → `-ERR invalid query`

### FT.SUGADD

```
FT.SUGADD IndexName Term Score ( "INCR" )? ( "PAYLOAD" Payload )?
Term := UTF-8 text token (1..256 chars)
Payload := UTF-8 text token
```

Strict rules:

* Score required.
* `PAYLOAD` if present must be followed by one token.
* Unknown options rejected.

Return:

* integer 1 if inserted, 0 if updated.

### FT.SUGGET

```
FT.SUGGET IndexName Prefix ( "MAX" Integer )? ( "WITHSCORES" )? ( "WITHPAYLOADS" )? ( "FUZZY" )?
```

v1 strict subset:

* Support: `MAX`, `WITHSCORES`, `WITHPAYLOADS`
* If `FUZZY` is present:

  * either return `-ERR not supported yet`
  * or ignore (not recommended)
    Recommended: `-ERR not supported yet`

Defaults:

* MAX default = 5
* Prefix match uses SQL LIKE `prefix%`

Response shape:

* terms only
* terms + scores
* terms + payloads
* terms + scores + payloads

### FT.SUGDEL

```
FT.SUGDEL IndexName Term
```

Return integer 1/0.

---

## D.13.4 Parsing strategy (deterministic)

Implement a “strict cursor parser”:

* Read tokens sequentially.
* Match exact keywords at expected positions.
* Fail fast on unknown tokens.
* Do not attempt to “guess” intent.

Pseudo-approach:

1. `cmd = tokens[0].toUpperCase()`
2. switch cmd
3. inside each handler:

   * `expect(indexName)`
   * then read required tokens
   * then parse optional flags by while-loop with explicit match
4. After parsing, ensure cursor reached end (no trailing tokens).

This prevents ambiguous acceptance and makes tests precise.

---

## D.13.5 Required tests for parser strictness

For each FT command:

* Accepts valid examples exactly
* Rejects:

  * missing required keyword
  * unknown option
  * extra trailing tokens
  * odd field pairs for FT.ADD
  * invalid UTF-8 in field values
  * invalid index names
  * LIMIT missing args
  * negative LIMIT values
