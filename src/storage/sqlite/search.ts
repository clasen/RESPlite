/**
 * Search indices and FTS5 (SPEC_D). Index registry in search_indices;
 * per-index tables created by FT.CREATE. FTS5 contentless + BM25 ranking.
 */

import type Database from './driver.ts';
import type { SQLInputValue, Statement } from './driver.ts';

export interface SearchField {
  name: string;
  type: string;
}

export interface IndexSchema {
  version: number;
  fields: SearchField[];
  tokenizer: string;
}

export interface IndexMeta {
  name: string;
  schema_json: string;
  created_at: number;
  updated_at: number;
  schema: IndexSchema;
}

/** Server-level FT.SEARCH guards, modeled on RediSearch MINPREFIX, MAXSEARCHRESULTS and TIMEOUT. */
export interface SearchOptions {
  /** Minimum characters before `*` in a prefix term. Default 3. */
  minPrefix?: number;
  /** Matches counted and ranked per query; the reported total stops here. Default 10000. */
  maxResults?: number;
  /** Default per-query time budget in ms; 0 disables it. FT.SEARCH TIMEOUT overrides it. Default 500. */
  timeoutMs?: number;
}

export type SearchLimits = Required<SearchOptions>;

export class SearchTimeoutError extends Error {
  constructor() {
    super('ERR Timeout limit was reached');
  }
}

const INDEX_NAME_RE = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;
const MAX_SEARCH_LIMIT = 1000;
const DEFAULT_SEARCH_OFFSET = 0;
const DEFAULT_SEARCH_COUNT = 10;
/** Rows read between deadline checks. */
const DEADLINE_CHECK_ROWS = 64;

/**
 * Resolve FT.SEARCH guards. Throws on invalid values so misconfiguration fails at startup.
 */
export function resolveSearchLimits(opts: SearchOptions = {}): SearchLimits {
  const limits = {
    minPrefix: opts.minPrefix ?? 3,
    maxResults: opts.maxResults ?? 10000,
    timeoutMs: opts.timeoutMs ?? 500,
  };
  if (!Number.isSafeInteger(limits.minPrefix) || limits.minPrefix < 1) {
    throw new Error('invalid search option: minPrefix must be a positive integer');
  }
  if (!Number.isSafeInteger(limits.maxResults) || limits.maxResults < 1) {
    throw new Error('invalid search option: maxResults must be a positive integer');
  }
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 0) {
    throw new Error('invalid search option: timeoutMs must be a non-negative integer');
  }
  return Object.freeze(limits);
}

/**
 * Validate index name (D.12.1). Throws if invalid.
 */
export function validateIndexName(name: string): void {
  if (typeof name !== 'string' || !INDEX_NAME_RE.test(name)) {
    throw new Error('ERR invalid index name');
  }
}

/**
 * Safe table name for an index (only call after validateIndexName).
 * @param suffix - e.g. 'docs', 'fts', 'docmap', 'sugs'
 */
function tableName(idx: string, suffix: string): string {
  return `search_${suffix}__${idx}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export interface IndexCounts {
  num_docs: number;
  fts_rows: number;
  num_suggestions: number;
}

interface SearchCounters {
  dataVersionStmt: Statement;
  dataVersion: number;
  byIndex: Map<string, IndexCounts>;
}

const searchCounters = new WeakMap<Database, SearchCounters>();

/**
 * In-memory FT.INFO counts per index for a connection. An index is counted once,
 * when first needed (loadSearchCounts does it at startup), then kept in step by the
 * writes below; rolled-back deltas are undone. Commits by other connections change
 * PRAGMA data_version, which drops the counts so they are taken again.
 */
function indexCounts(db: Database, idx: string): IndexCounts {
  let state = searchCounters.get(db);
  const dataVersionStmt = state?.dataVersionStmt ?? db.prepare('PRAGMA data_version').pluck();
  const dataVersion: number = dataVersionStmt.get();
  if (!state || state.dataVersion !== dataVersion) {
    state = { dataVersionStmt, dataVersion, byIndex: new Map() };
    searchCounters.set(db, state);
  }
  let counts = state.byIndex.get(idx);
  if (!counts) {
    const count = (suffix: string): number =>
      db.prepare(`SELECT COUNT(*) FROM ${quoteIdentifier(tableName(idx, suffix))}`).pluck().get();
    counts = { num_docs: count('docs'), fts_rows: count('fts'), num_suggestions: count('sugs') };
    state.byIndex.set(idx, counts);
  }
  return counts;
}

/**
 * Apply a delta to an index's in-memory count after the write that caused it.
 * Writers take `counts` from indexCounts before writing, so a first count never
 * includes the write it is about to be bumped for.
 */
function bumpCount(db: Database, counts: IndexCounts, column: keyof IndexCounts, delta: number): void {
  counts[column] += delta;
  db.onRollback(() => {
    counts[column] -= delta;
  });
}

/** Forget the counts of every index, so they are counted again when next needed. */
function resetSearchCounts(db: Database): void {
  searchCounters.get(db)?.byIndex.clear();
  db.onRollback(() => searchCounters.get(db)?.byIndex.clear());
}

/**
 * Count every index now, so no client command pays for the first full count.
 * Full scans of each index: run once when the server starts.
 */
export function loadSearchCounts(db: Database): void {
  for (const name of db.prepare('SELECT name FROM search_indices').pluck().all()) {
    validateIndexName(name);
    indexCounts(db, name);
  }
}

/**
 * Remove all RESP-visible search indices, documents and suggestions.
 * Migration bookkeeping is intentionally stored separately and is not touched.
 */
export function clearSearchData(db: Database): void {
  const names = db.prepare('SELECT name FROM search_indices').pluck().all();
  for (const name of names) {
    validateIndexName(name);
    for (const suffix of ['fts', 'docs', 'docmap', 'sugs']) {
      db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName(name, suffix))}`);
    }
  }
  db.prepare('DELETE FROM search_indices').run();
  db.prepare('DELETE FROM search_rowid_allocator').run();
  resetSearchCounts(db);
}

/**
 * Build deterministic sorted field names for FTS column order.
 */
function getSortedFieldNames(schema: { fields: SearchField[] }): string[] {
  return schema.fields.map((f) => f.name).sort();
}

/**
 * Encode field values in deterministic FTS column order.
 * Missing values are normalized to empty string to match insert semantics.
 */
function encodeFtsFieldValues(fieldNames: string[], fields: Record<string, string>): string[] {
  return fieldNames.map((f) => fields[f] ?? '');
}

/**
 * Delete a specific contentless FTS row using the special 'delete' command row.
 * FTS5 requires passing the exact prior values for all indexed columns.
 */
function deleteFtsRow(
  db: Database,
  counts: IndexCounts,
  ftsTableName: string,
  ftsRowid: number,
  fieldNames: string[],
  fields: Record<string, string>,
): void {
  const values = encodeFtsFieldValues(fieldNames, fields);
  const columns = [ftsTableName, 'rowid', ...fieldNames];
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${ftsTableName}(${columns.join(', ')}) VALUES (${placeholders})`).run(
    'delete',
    ftsRowid,
    ...values
  );
  bumpCount(db, counts, 'fts_rows', -1);
}

/**
 * Allocate a monotonic FTS rowid that is never reused, even after deletes.
 * This prevents legacy stale tokens from being remapped to a new document.
 */
function allocateFtsRowid(db: Database, docmapTableName: string): number {
  const maxDocmapRowid = db
    .prepare(`SELECT COALESCE(MAX(fts_rowid), 0) AS m FROM ${docmapTableName}`)
    .get().m;
  const maxAllocated = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM search_rowid_allocator').get().m;
  const nextRowid = Math.max(maxDocmapRowid, maxAllocated) + 1;
  db.prepare('INSERT INTO search_rowid_allocator(id) VALUES (?)').run(nextRowid);
  return nextRowid;
}

/**
 * Build canonical schema JSON (fields sorted by name). D.12.2
 */
function buildSchemaJson(fields: SearchField[]): string {
  const sorted = [...fields].sort((a, b) => (a.name < b.name ? -1 : 1));
  return JSON.stringify({
    version: 1,
    fields: sorted,
    tokenizer: 'unicode61',
  });
}

/**
 * Create a new search index. Atomic: registry + docs, docmap, fts, sugs tables.
 * @param name - Index name (must pass validateIndexName)
 * @param fields - At least one, must include payload TEXT
 */
export function createIndex(db: Database, name: string, fields: SearchField[]): void {
  validateIndexName(name);
  if (!fields || fields.length === 0) throw new Error('ERR syntax error');
  const hasPayload = fields.some((f) => f.name === 'payload' && f.type === 'TEXT');
  if (!hasPayload) throw new Error('ERR payload field required');
  for (const f of fields) {
    if (f.type !== 'TEXT') throw new Error('ERR unsupported field type');
  }

  const existing = db.prepare('SELECT 1 FROM search_indices WHERE name = ?').get(name);
  if (existing) throw new Error('ERR index already exists');

  const schemaJson = buildSchemaJson(fields);
  const now = Date.now();
  const docsT = tableName(name, 'docs');
  const ftsT = tableName(name, 'fts');
  const docmapT = tableName(name, 'docmap');
  const sugsT = tableName(name, 'sugs');
  const sugsScoreIdx = `search_sugs__${name}_score_idx`;

  const ftsColumns = fields.map((f) => f.name).sort().join(',\n  ');

  const run = db.transaction(() => {
    db.prepare(
      'INSERT INTO search_indices(name, schema_json, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(name, schemaJson, now, now);

    db.exec(`
      CREATE TABLE ${docsT} (
        doc_id TEXT PRIMARY KEY,
        score REAL NOT NULL DEFAULT 1.0,
        fields_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE ${docmapT} (
        doc_id TEXT PRIMARY KEY,
        fts_rowid INTEGER NOT NULL UNIQUE
      );
      CREATE VIRTUAL TABLE ${ftsT} USING fts5(
        ${ftsColumns},
        tokenize='unicode61',
        content=''
      );
      CREATE TABLE ${sugsT} (
        term TEXT PRIMARY KEY,
        score REAL NOT NULL,
        payload TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX ${sugsScoreIdx} ON ${sugsT}(score DESC);
    `);
  });

  run();
}

/**
 * Get index metadata. Throws if index does not exist.
 */
export function getIndexMeta(db: Database, name: string): IndexMeta {
  validateIndexName(name);
  const row = db.prepare(
    'SELECT name, schema_json, created_at, updated_at FROM search_indices WHERE name = ?'
  ).get(name);
  if (!row) throw new Error('Unknown index name');
  const schema: IndexSchema = JSON.parse(row.schema_json);
  return {
    name: row.name,
    schema_json: row.schema_json,
    created_at: row.created_at,
    updated_at: row.updated_at,
    schema,
  };
}

/**
 * Add or replace a document. If doc exists and replace is false, throws ERR document exists.
 * @param fields - Field name -> value (must match schema)
 */
export function addDocument(
  db: Database,
  idx: string,
  docId: string,
  score: number,
  replace: boolean,
  fields: Record<string, string>,
): void {
  const meta = getIndexMeta(db, idx);
  const counts = indexCounts(db, idx);
  const fieldNames = getSortedFieldNames(meta.schema);
  for (const k of Object.keys(fields)) {
    if (!fieldNames.includes(k)) throw new Error('ERR unknown field');
  }

  const docsT = tableName(idx, 'docs');
  const docmapT = tableName(idx, 'docmap');
  const ftsT = tableName(idx, 'fts');
  const now = Date.now();
  const fieldsJson = JSON.stringify(fields);

  const run = db.transaction(() => {
    const existing = db.prepare(`SELECT fts_rowid FROM ${docmapT} WHERE doc_id = ?`).get(docId);
    let ftsRowid: number;
    if (existing) {
      if (!replace) throw new Error('ERR document exists');
      const previousRowid = existing.fts_rowid;
      ftsRowid = allocateFtsRowid(db, docmapT);
      db.prepare(`UPDATE ${docmapT} SET fts_rowid = ? WHERE doc_id = ?`).run(ftsRowid, docId);
      const oldDoc = db.prepare(`SELECT fields_json FROM ${docsT} WHERE doc_id = ?`).get(docId);
      if (oldDoc?.fields_json) {
        const oldFields = JSON.parse(oldDoc.fields_json);
        deleteFtsRow(db, counts, ftsT, previousRowid, fieldNames, oldFields);
      }
    } else {
      ftsRowid = allocateFtsRowid(db, docmapT);
      db.prepare(`INSERT INTO ${docmapT}(doc_id, fts_rowid) VALUES (?, ?)`).run(docId, ftsRowid);
    }

    const docRow = db.prepare(`SELECT 1 FROM ${docsT} WHERE doc_id = ?`).get(docId);
    if (docRow) {
      db.prepare(
        `UPDATE ${docsT} SET score = ?, fields_json = ?, updated_at = ? WHERE doc_id = ?`
      ).run(score, fieldsJson, now, docId);
    } else {
      db.prepare(
        `INSERT INTO ${docsT}(doc_id, score, fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).run(docId, score, fieldsJson, now, now);
      bumpCount(db, counts, 'num_docs', 1);
    }

    const ftsColumns = ['rowid', ...fieldNames];
    const ftsValues: SQLInputValue[] = [ftsRowid, ...encodeFtsFieldValues(fieldNames, fields)];
    const placeholders = ftsValues.map(() => '?').join(', ');
    const colList = ftsColumns.join(', ');
    db.prepare(`INSERT INTO ${ftsT}(${colList}) VALUES (${placeholders})`).run(...ftsValues);
    bumpCount(db, counts, 'fts_rows', 1);
  });

  run();
}

/**
 * Delete document by doc_id. Returns 1 if deleted, 0 if not found.
 */
/**
 * Load stored fields for FT.GET: flat [field, value, ...] in schema field order.
 * RediSearch-compatible: empty string values encode as null in RESP.
 * @returns null if document is not in the index
 */
export function getDocumentFields(db: Database, idx: string, docId: string): (string | null)[] | null {
  const meta = getIndexMeta(db, idx);
  const docsT = tableName(idx, 'docs');
  const row = db.prepare(`SELECT fields_json FROM ${docsT} WHERE doc_id = ?`).get(docId);
  if (!row) return null;
  const fields: Record<string, string> = JSON.parse(row.fields_json);
  const flat: (string | null)[] = [];
  for (const f of meta.schema.fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, f.name)) continue;
    const v = fields[f.name];
    flat.push(f.name, v === '' ? null : v);
  }
  return flat;
}

export function deleteDocument(db: Database, idx: string, docId: string): number {
  const meta = getIndexMeta(db, idx);
  const counts = indexCounts(db, idx);
  const fieldNames = getSortedFieldNames(meta.schema);
  const docsT = tableName(idx, 'docs');
  const docmapT = tableName(idx, 'docmap');
  const ftsT = tableName(idx, 'fts');

  const row = db.prepare(`SELECT fts_rowid FROM ${docmapT} WHERE doc_id = ?`).get(docId);
  if (!row) return 0;

  db.transaction(() => {
    const docRow = db.prepare(`SELECT fields_json FROM ${docsT} WHERE doc_id = ?`).get(docId);
    if (docRow?.fields_json) {
      const fields = JSON.parse(docRow.fields_json);
      deleteFtsRow(db, counts, ftsT, row.fts_rowid, fieldNames, fields);
    }
    const deletedDocs = db.prepare(`DELETE FROM ${docsT} WHERE doc_id = ?`).run(docId).changes;
    bumpCount(db, counts, 'num_docs', -Number(deletedDocs));
    db.prepare(`DELETE FROM ${docmapT} WHERE doc_id = ?`).run(docId);
  })();
  return 1;
}

/**
 * Build a safe FTS5 MATCH expression from user query.
 *
 * We intentionally normalize punctuation so query tokenization is flexible and
 * closer to Redis/RediSearch behavior for common free-text searches:
 * - punctuation like ".", "#", "+", "/", ",", "(", ")" acts as separators
 * - "?" is ignored as punctuation
 * - "-" inside terms acts as separator (hello-world -> hello world)
 * - "-term" (leading minus) maps to boolean NOT term
 * - "@" and ":" are treated as unsupported query syntax and return syntax error
 *
 * Supported term chars are unicode letters/digits plus underscore, with
 * optional trailing "*" for prefix queries.
 *
 * Reject control characters and unsafe MATCH breakers: " ' \ and non-printable.
 * Prefix terms shorter than minPrefix characters are rejected: FTS5 merges the
 * posting lists of every matching term before returning the first row.
 * @returns Safe MATCH expression e.g. "martin NOT clasen*"
 */
function buildMatchExpression(query: string, minPrefix: number): string {
  if (typeof query !== 'string') throw new Error('ERR invalid query');
  const trimmed = query.trim();
  if (trimmed === '') throw new Error('ERR invalid query');
  if (/[\x00-\x1f]/.test(query) || /["'\\]/.test(query)) throw new Error('ERR invalid query');
  if (query.includes('@') || query.includes(':')) throw new Error('ERR syntax error');

  const normalized = trimmed
    .replace(/\?/g, '')
    .replace(/[^\p{L}\p{N}_*\-\s]+/gu, ' ')
    .trim();
  const rawTokens = normalized.split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0) throw new Error('ERR invalid query');

  const termRe = /^[\p{L}\p{N}_]+\*?$/u;
  const tokens: string[] = [];

  for (const raw of rawTokens) {
    if (raw.startsWith('-')) {
      const neg = raw.slice(1);
      if (!neg || neg.includes('-') || !termRe.test(neg)) throw new Error('ERR invalid query');
      tokens.push('NOT', neg);
      continue;
    }
    const segments = raw.split('-').filter(Boolean);
    if (segments.length === 0) throw new Error('ERR invalid query');
    for (const seg of segments) {
      if (!termRe.test(seg)) throw new Error('ERR invalid query');
      tokens.push(seg);
    }
  }

  for (const token of tokens) {
    if (token.endsWith('*') && [...token].length - 1 < minPrefix) {
      throw new Error(`ERR prefix "${token}" is shorter than the minimum of ${minPrefix} characters`);
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'NOT') {
      if (i === 0 || i === tokens.length - 1 || tokens[i + 1] === 'NOT') {
        throw new Error('ERR invalid query');
      }
    }
  }

  return tokens.join(' ');
}

export interface SearchQueryOptions {
  offset?: number;
  count?: number;
  noContent?: boolean;
  limits?: SearchLimits;
  /** Per-query time budget in ms (0 = none); defaults to limits.timeoutMs. */
  timeoutMs?: number;
  /** Monotonic ms clock for the time budget. */
  clock?: () => number;
}

/**
 * Search index. Returns { total, docIds, fieldsByDoc? }.
 *
 * Reads matches in one pass in index order, stopping after limits.maxResults
 * (the reported total is capped there) and ranking only what was read:
 * FTS5 bm25 is more negative for better matches, so lower bm25 * score ranks first.
 * The time budget is checked between rows; node:sqlite cannot interrupt a
 * running step, so FTS5 setup work before the first row is bounded only by minPrefix.
 */
export function search(
  db: Database,
  idx: string,
  query: string,
  options: SearchQueryOptions = {},
): { total: number; docIds: string[]; fieldsByDoc: Record<string, Record<string, string>> | undefined } {
  getIndexMeta(db, idx);
  const limits = options.limits ?? resolveSearchLimits();
  const matchExpr = buildMatchExpression(query, limits.minPrefix);
  const offset = Math.max(0, options.offset ?? DEFAULT_SEARCH_OFFSET);
  const count = options.count ?? DEFAULT_SEARCH_COUNT;
  if (count < 0 || count > MAX_SEARCH_LIMIT) throw new Error('ERR invalid limit');
  const noContent = options.noContent === true;
  const clock = options.clock ?? performance.now.bind(performance);
  const timeoutMs = options.timeoutMs ?? limits.timeoutMs;
  const deadline = timeoutMs > 0 ? clock() + timeoutMs : Infinity;

  const docsT = tableName(idx, 'docs');
  const docmapT = tableName(idx, 'docmap');
  const ftsT = tableName(idx, 'fts');

  const matches = db
    .prepare(
      `SELECT m.doc_id, bm25(${ftsT}) * d.score AS rank
         FROM ${ftsT} f
         JOIN ${docmapT} m ON f.rowid = m.fts_rowid
         JOIN ${docsT} d ON d.doc_id = m.doc_id
        WHERE ${ftsT} MATCH ?`
    )
    .raw()
    .iterate(matchExpr);

  const ranked: { docId: string; rank: number; order: number }[] = [];
  for (const [docId, rank] of matches) {
    if (ranked.length % DEADLINE_CHECK_ROWS === 0 && clock() > deadline) throw new SearchTimeoutError();
    ranked.push({ docId, rank, order: ranked.length });
    if (ranked.length >= limits.maxResults) break;
  }
  if (clock() > deadline) throw new SearchTimeoutError();

  ranked.sort((x, y) => x.rank - y.rank || x.order - y.order);
  const docIds = ranked.slice(offset, offset + count).map((r) => r.docId);

  let fieldsByDoc: Record<string, Record<string, string>> | undefined;
  if (!noContent) {
    const fieldsStmt = db.prepare(`SELECT fields_json FROM ${docsT} WHERE doc_id = ?`).pluck();
    fieldsByDoc = {};
    for (const docId of docIds) {
      fieldsByDoc[docId] = JSON.parse(fieldsStmt.get(docId));
    }
  }

  return { total: ranked.length, docIds, fieldsByDoc };
}

/**
 * Add or update suggestion. Returns 1 if inserted, 0 if updated.
 * @param incr - If true and exists, add to score
 */
export function suggestionAdd(
  db: Database,
  idx: string,
  term: string,
  score: number,
  incr: boolean,
  payload?: string,
): number {
  getIndexMeta(db, idx);
  const counts = indexCounts(db, idx);
  const sugsT = tableName(idx, 'sugs');
  const now = Date.now();
  const existing = db.prepare(`SELECT score FROM ${sugsT} WHERE term = ?`).get(term);
  if (existing) {
    const newScore = incr ? existing.score + score : score;
    db.prepare(`UPDATE ${sugsT} SET score = ?, payload = ?, updated_at = ? WHERE term = ?`).run(
      newScore,
      payload ?? null,
      now,
      term
    );
    return 0;
  }
  db.prepare(`INSERT INTO ${sugsT}(term, score, payload, updated_at) VALUES (?, ?, ?, ?)`).run(
    term,
    score,
    payload ?? null,
    now
  );
  bumpCount(db, counts, 'num_suggestions', 1);
  return 1;
}

/**
 * Get suggestions by prefix. Returns array of terms (and optionally scores/payloads interleaved).
 */
export function suggestionGet(
  db: Database,
  idx: string,
  prefix: string,
  options: { max?: number; withScores?: boolean; withPayloads?: boolean } = {},
): (string | number)[] {
  getIndexMeta(db, idx);
  const sugsT = tableName(idx, 'sugs');
  const max = Math.max(0, options.max ?? 5);
  const withScores = options.withScores === true;
  const withPayloads = options.withPayloads === true;

  const rows = db
    .prepare(
      `SELECT term, score, payload FROM ${sugsT} WHERE term LIKE ? ORDER BY score DESC, term ASC LIMIT ?`
    )
    .all(prefix + '%', max);

  const result: (string | number)[] = [];
  for (const r of rows) {
    result.push(r.term);
    if (withScores) result.push(r.score);
    if (withPayloads) result.push(r.payload ?? '');
  }
  return result;
}

/**
 * Delete suggestion by term. Returns 1 if deleted, 0 if not found.
 */
export function suggestionDel(db: Database, idx: string, term: string): number {
  getIndexMeta(db, idx);
  const counts = indexCounts(db, idx);
  const sugsT = tableName(idx, 'sugs');
  const info = db.prepare(`DELETE FROM ${sugsT} WHERE term = ?`).run(term);
  if (info.changes === 0) return 0;
  bumpCount(db, counts, 'num_suggestions', -1);
  return 1;
}

/**
 * Get maintained counts for FT.INFO: num_docs, fts_rows, num_suggestions.
 */
export function getIndexCounts(db: Database, idx: string): IndexCounts {
  getIndexMeta(db, idx);
  return { ...indexCounts(db, idx) };
}
