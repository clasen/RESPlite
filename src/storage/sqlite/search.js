/**
 * Search indices and FTS5 (SPEC_D). Index registry in search_indices;
 * per-index tables created by FT.CREATE. FTS5 contentless + BM25 ranking.
 */

const INDEX_NAME_RE = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;
const MAX_SEARCH_LIMIT = 1000;
const DEFAULT_SEARCH_OFFSET = 0;
const DEFAULT_SEARCH_COUNT = 10;

/**
 * Validate index name (D.12.1). Throws if invalid.
 * @param {string} name
 */
export function validateIndexName(name) {
  if (typeof name !== 'string' || !INDEX_NAME_RE.test(name)) {
    throw new Error('ERR invalid index name');
  }
}

/**
 * Safe table name for an index (only call after validateIndexName).
 * @param {string} idx
 * @param {string} suffix - e.g. 'docs', 'fts', 'docmap', 'sugs'
 * @returns {string}
 */
function tableName(idx, suffix) {
  return `search_${suffix}__${idx}`;
}

/**
 * Build deterministic sorted field names for FTS column order.
 * @param {{ fields: { name: string, type: string }[] }} schema
 * @returns {string[]}
 */
function getSortedFieldNames(schema) {
  return schema.fields.map((f) => f.name).sort();
}

/**
 * Encode field values in deterministic FTS column order.
 * Missing values are normalized to empty string to match insert semantics.
 * @param {string[]} fieldNames
 * @param {Record<string, string>} fields
 * @returns {string[]}
 */
function encodeFtsFieldValues(fieldNames, fields) {
  return fieldNames.map((f) => fields[f] ?? '');
}

/**
 * Delete a specific contentless FTS row using the special 'delete' command row.
 * FTS5 requires passing the exact prior values for all indexed columns.
 * @param {import('better-sqlite3').Database} db
 * @param {string} ftsTableName
 * @param {number} ftsRowid
 * @param {string[]} fieldNames
 * @param {Record<string, string>} fields
 */
function deleteFtsRow(db, ftsTableName, ftsRowid, fieldNames, fields) {
  const values = encodeFtsFieldValues(fieldNames, fields);
  const columns = [ftsTableName, 'rowid', ...fieldNames];
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${ftsTableName}(${columns.join(', ')}) VALUES (${placeholders})`).run(
    'delete',
    ftsRowid,
    ...values
  );
}

/**
 * Allocate a monotonic FTS rowid that is never reused, even after deletes.
 * This prevents legacy stale tokens from being remapped to a new document.
 * @param {import('better-sqlite3').Database} db
 * @param {string} docmapTableName
 * @returns {number}
 */
function allocateFtsRowid(db, docmapTableName) {
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
 * @param {{ name: string, type: string }[]} fields
 * @returns {string}
 */
function buildSchemaJson(fields) {
  const sorted = [...fields].sort((a, b) => (a.name < b.name ? -1 : 1));
  return JSON.stringify({
    version: 1,
    fields: sorted,
    tokenizer: 'unicode61',
  });
}

/**
 * Create a new search index. Atomic: registry + docs, docmap, fts, sugs tables.
 * @param {import('better-sqlite3').Database} db
 * @param {string} name - Index name (must pass validateIndexName)
 * @param {{ name: string, type: string }[]} fields - At least one, must include payload TEXT
 */
export function createIndex(db, name, fields) {
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
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @returns {{ name: string, schema_json: string, created_at: number, updated_at: number, schema: { fields: { name: string, type: string }[] } }}
 */
export function getIndexMeta(db, name) {
  validateIndexName(name);
  const row = db.prepare(
    'SELECT name, schema_json, created_at, updated_at FROM search_indices WHERE name = ?'
  ).get(name);
  if (!row) throw new Error('Unknown index name');
  const schema = JSON.parse(row.schema_json);
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
 * @param {import('better-sqlite3').Database} db
 * @param {string} idx
 * @param {string} docId
 * @param {number} score
 * @param {boolean} replace
 * @param {Record<string, string>} fields - Field name -> value (must match schema)
 */
export function addDocument(db, idx, docId, score, replace, fields) {
  const meta = getIndexMeta(db, idx);
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
    let ftsRowid;
    if (existing) {
      if (!replace) throw new Error('ERR document exists');
      const previousRowid = existing.fts_rowid;
      ftsRowid = allocateFtsRowid(db, docmapT);
      db.prepare(`UPDATE ${docmapT} SET fts_rowid = ? WHERE doc_id = ?`).run(ftsRowid, docId);
      const oldDoc = db.prepare(`SELECT fields_json FROM ${docsT} WHERE doc_id = ?`).get(docId);
      if (oldDoc?.fields_json) {
        const oldFields = JSON.parse(oldDoc.fields_json);
        deleteFtsRow(db, ftsT, previousRowid, fieldNames, oldFields);
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
    }

    const ftsColumns = ['rowid', ...fieldNames];
    const ftsValues = [ftsRowid, ...encodeFtsFieldValues(fieldNames, fields)];
    const placeholders = ftsValues.map(() => '?').join(', ');
    const colList = ftsColumns.join(', ');
    db.prepare(`INSERT INTO ${ftsT}(${colList}) VALUES (${placeholders})`).run(...ftsValues);
  });

  run();
}

/**
 * Delete document by doc_id. Returns 1 if deleted, 0 if not found.
 * @param {import('better-sqlite3').Database} db
 * @param {string} idx
 * @param {string} docId
 * @returns {number}
 */
/**
 * Load stored fields for FT.GET: flat [field, value, ...] in schema field order.
 * RediSearch-compatible: empty string values encode as null in RESP.
 * @param {import('better-sqlite3').Database} db
 * @param {string} idx
 * @param {string} docId
 * @returns { (string|null)[] | null } - null if document is not in the index
 */
export function getDocumentFields(db, idx, docId) {
  const meta = getIndexMeta(db, idx);
  const docsT = tableName(idx, 'docs');
  const row = db.prepare(`SELECT fields_json FROM ${docsT} WHERE doc_id = ?`).get(docId);
  if (!row) return null;
  const fields = JSON.parse(row.fields_json);
  const flat = [];
  for (const f of meta.schema.fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, f.name)) continue;
    const v = fields[f.name];
    flat.push(f.name, v === '' ? null : v);
  }
  return flat;
}

export function deleteDocument(db, idx, docId) {
  const meta = getIndexMeta(db, idx);
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
      deleteFtsRow(db, ftsT, row.fts_rowid, fieldNames, fields);
    }
    db.prepare(`DELETE FROM ${docsT} WHERE doc_id = ?`).run(docId);
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
 * @param {string} query
 * @returns {string} - Safe MATCH expression e.g. "martin NOT clasen*"
 */
function buildMatchExpression(query) {
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
  const tokens = [];

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

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'NOT') {
      if (i === 0 || i === tokens.length - 1 || tokens[i + 1] === 'NOT') {
        throw new Error('ERR invalid query');
      }
    }
  }

  return tokens.join(' ');
}

/**
 * Search index. Returns { total, docIds, fieldsByDoc? }. FTS5 bm25: more negative = better, so ORDER BY bm25 ASC.
 * @param {import('better-sqlite3').Database} db
 * @param {string} idx
 * @param {string} query
 * @param {{ offset?: number, count?: number, noContent?: boolean }} options
 */
export function search(db, idx, query, options = {}) {
  getIndexMeta(db, idx);
  const matchExpr = buildMatchExpression(query);
  const offset = Math.max(0, options.offset ?? DEFAULT_SEARCH_OFFSET);
  let count = options.count ?? DEFAULT_SEARCH_COUNT;
  if (count < 0 || count > MAX_SEARCH_LIMIT) throw new Error('ERR invalid limit');
  const noContent = options.noContent === true;

  const docsT = tableName(idx, 'docs');
  const docmapT = tableName(idx, 'docmap');
  const ftsT = tableName(idx, 'fts');

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${ftsT} f JOIN ${docmapT} m ON f.rowid = m.fts_rowid WHERE ${ftsT} MATCH ?`
    )
    .get(matchExpr);
  const total = totalRow?.c ?? 0;

  const orderExpr = `bm25(${ftsT}) * d.score ASC`;
  const joinSql = `${ftsT} f JOIN ${docmapT} m ON f.rowid = m.fts_rowid JOIN ${docsT} d ON d.doc_id = m.doc_id`;
  const whereSql = `${ftsT} MATCH ?`;

  const rows = db
    .prepare(
      `SELECT m.doc_id, d.fields_json FROM ${joinSql} WHERE ${whereSql} ORDER BY ${orderExpr} LIMIT ? OFFSET ?`
    )
    .all(matchExpr, count, offset);

  const docIds = rows.map((r) => r.doc_id);
  let fieldsByDoc;
  if (!noContent) {
    fieldsByDoc = {};
    for (const r of rows) {
      fieldsByDoc[r.doc_id] = JSON.parse(r.fields_json);
    }
  }

  return { total, docIds, fieldsByDoc };
}

/**
 * Add or update suggestion. Returns 1 if inserted, 0 if updated.
 * @param {import('better-sqlite3').Database} db
 * @param {string} idx
 * @param {string} term
 * @param {number} score
 * @param {boolean} incr - If true and exists, add to score
 * @param {string} [payload]
 * @returns {number}
 */
export function suggestionAdd(db, idx, term, score, incr, payload) {
  getIndexMeta(db, idx);
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
  return 1;
}

/**
 * Get suggestions by prefix. Returns array of terms (and optionally scores/payloads interleaved).
 * @param {import('better-sqlite3').Database} db
 * @param {string} idx
 * @param {string} prefix
 * @param {{ max?: number, withScores?: boolean, withPayloads?: boolean }} options
 * @returns { (string | number)[] }
 */
export function suggestionGet(db, idx, prefix, options = {}) {
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

  const result = [];
  for (const r of rows) {
    result.push(r.term);
    if (withScores) result.push(r.score);
    if (withPayloads) result.push(r.payload ?? '');
  }
  return result;
}

/**
 * Delete suggestion by term. Returns 1 if deleted, 0 if not found.
 * @param {import('better-sqlite3').Database} db
 * @param {string} idx
 * @param {string} term
 * @returns {number}
 */
export function suggestionDel(db, idx, term) {
  getIndexMeta(db, idx);
  const sugsT = tableName(idx, 'sugs');
  const info = db.prepare(`DELETE FROM ${sugsT} WHERE term = ?`).run(term);
  return info.changes > 0 ? 1 : 0;
}

/**
 * Get counts for FT.INFO: num_docs, fts_rows, num_suggestions.
 * @param {import('better-sqlite3').Database} db
 * @param {string} idx
 * @returns {{ num_docs: number, fts_rows: number, num_suggestions: number }}
 */
export function getIndexCounts(db, idx) {
  getIndexMeta(db, idx);
  const docsT = tableName(idx, 'docs');
  const ftsT = tableName(idx, 'fts');
  const sugsT = tableName(idx, 'sugs');
  const numDocs = db.prepare(`SELECT COUNT(*) AS c FROM ${docsT}`).get().c;
  const ftsRows = db.prepare(`SELECT COUNT(*) AS c FROM ${ftsT}`).get().c;
  const numSugs = db.prepare(`SELECT COUNT(*) AS c FROM ${sugsT}`).get().c;
  return { num_docs: numDocs, fts_rows: ftsRows, num_suggestions: numSugs };
}
