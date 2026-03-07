/**
 * Migrate RediSearch indices to RespLite FT.* search indices (SPEC_F §F.10).
 *
 * For each index in the source Redis:
 *   1. FT._LIST  → enumerate index names
 *   2. FT.INFO   → read schema (prefix patterns, field attributes)
 *   3. Map RediSearch field types to RespLite TEXT fields
 *   4. FT.CREATE in RespLite (or reuse the existing destination index when skipExisting=true)
 *   5. SCAN keys by prefix → HGETALL → addDocument in SQLite batches
 *   6. FT.SUGGET  → import suggestions
 *
 * Graceful shutdown: SIGINT/SIGTERM finishes the current document, checkpoints, closes DB.
 */

import { openDb } from '../storage/sqlite/db.js';
import { createIndex, addDocument, suggestionAdd } from '../storage/sqlite/search.js';

const INDEX_NAME_RE = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;

/** RediSearch field types that can be represented as TEXT in RespLite. */
const TEXT_COMPATIBLE = new Set(['TEXT', 'TAG', 'NUMERIC']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * List all RediSearch index names via FT._LIST.
 * Returns [] if the command fails (e.g. RediSearch module not loaded).
 * @param {import('redis').RedisClientType} redisClient
 * @returns {Promise<string[]>}
 */
async function listSearchIndices(redisClient) {
  try {
    const raw = await redisClient.sendCommand(['FT._LIST']);
    if (!Array.isArray(raw)) return [];
    return raw.map(String);
  } catch (_) {
    return [];
  }
}

/**
 * Parse a flat alternating [key, value, key, value, …] Redis response array into a plain object.
 * Keys are lower-cased; nested arrays are kept as-is.
 * @param {unknown} arr
 * @returns {Record<string, unknown>}
 */
function parseFlat(arr) {
  if (!Array.isArray(arr)) return {};
  const out = {};
  for (let i = 0; i + 1 < arr.length; i += 2) {
    out[String(arr[i]).toLowerCase()] = arr[i + 1];
  }
  return out;
}

/**
 * Get RediSearch index info (key type, prefix patterns, field attributes) via FT.INFO.
 * @param {import('redis').RedisClientType} redisClient
 * @param {string} indexName
 * @returns {Promise<{
 *   keyType: string,
 *   prefixes: string[],
 *   attributes: Array<{ identifier: string, attribute: string, type: string }>
 * }>}
 */
async function getSearchIndexInfo(redisClient, indexName) {
  const raw = await redisClient.sendCommand(['FT.INFO', indexName]);

  // node-redis v4 may return a plain object when the Search module is loaded natively,
  // or a flat array from sendCommand. Handle both.
  let info;
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    info = {};
    for (const [k, v] of Object.entries(raw)) info[k.toLowerCase()] = v;
  } else {
    info = parseFlat(raw);
  }

  // ── index_definition → key_type + prefixes ───────────────────────────
  let keyType = 'HASH';
  let prefixes = [''];
  const rawDef = info['index_definition'] ?? info['indexdefinition'];
  if (Array.isArray(rawDef)) {
    const def = parseFlat(rawDef);
    if (def['key_type']) keyType = String(def['key_type']).toUpperCase();
    const p = def['prefixes'];
    if (Array.isArray(p) && p.length > 0) prefixes = p.map(String);
    else if (typeof p === 'string' && p.length > 0) prefixes = [p];
  } else if (rawDef && typeof rawDef === 'object') {
    if (rawDef.key_type) keyType = String(rawDef.key_type).toUpperCase();
    const p = rawDef.prefixes;
    if (Array.isArray(p) && p.length > 0) prefixes = p.map(String);
  }

  // ── attributes (newer) or fields (older RediSearch) ──────────────────
  const rawAttrs = info['attributes'] ?? info['fields'] ?? [];
  const attributes = [];
  if (Array.isArray(rawAttrs)) {
    for (const attr of rawAttrs) {
      let identifier, attribute, type;
      if (Array.isArray(attr)) {
        const a = parseFlat(attr);
        identifier = String(a['identifier'] ?? '');
        attribute  = String(a['attribute']  ?? a['identifier'] ?? '');
        type       = String(a['type']       ?? 'TEXT').toUpperCase();
      } else if (attr && typeof attr === 'object') {
        identifier = String(attr.identifier ?? '');
        attribute  = String(attr.attribute  ?? attr.identifier ?? '');
        type       = String(attr.type       ?? 'TEXT').toUpperCase();
      }
      if (identifier) attributes.push({ identifier, attribute, type });
    }
  }

  return { keyType, prefixes, attributes };
}

/**
 * Map RediSearch field attributes to RespLite schema fields.
 *
 * - TEXT            → TEXT (1:1)
 * - TAG, NUMERIC    → TEXT (with warning; values stringified at import time)
 * - GEO, VECTOR, …  → skipped with a warning
 * - Always guarantees a `payload` TEXT field exists (added if absent)
 *
 * @param {Array<{ identifier: string, attribute: string, type: string }>} attributes
 * @returns {{
 *   fields: Array<{ name: string, type: string }>,
 *   fieldMap: Map<string, string>,
 *   warnings: string[]
 * }}
 */
function mapFields(attributes) {
  const warnings  = [];
  const fields    = [];
  /** identifier (hash field name) → RespLite field name */
  const fieldMap  = new Map();
  const usedNames = new Set();

  for (const attr of attributes) {
    if (!TEXT_COMPATIBLE.has(attr.type)) {
      warnings.push(`Skipping field "${attr.attribute}" (type ${attr.type} is not supported)`);
      continue;
    }
    if (attr.type !== 'TEXT') {
      warnings.push(`Field "${attr.attribute}" mapped from ${attr.type} to TEXT`);
    }

    // Sanitize to a valid SQLite column / RespLite field name
    let safeName = attr.attribute.replace(/[^A-Za-z0-9:_-]/g, '_');
    if (/^[^A-Za-z]/.test(safeName)) safeName = 'f_' + safeName;
    safeName = safeName.slice(0, 64);

    if (!safeName || usedNames.has(safeName)) continue;
    usedNames.add(safeName);
    fields.push({ name: safeName, type: 'TEXT' });
    fieldMap.set(attr.identifier, safeName);
  }

  // RespLite requires a `payload` TEXT field
  if (!usedNames.has('payload')) {
    fields.push({ name: 'payload', type: 'TEXT' });
  }

  return { fields, fieldMap, warnings };
}

/**
 * Build the fields object for addDocument from a HGETALL result.
 * Fields absent from the hash default to ''.
 * If `payload` is empty, synthesise it as the concatenation of all other values.
 *
 * @param {Record<string, string>} hashData
 * @param {Map<string, string>} fieldMap   identifier → RespLite field name
 * @param {Array<{ name: string }>} schemaFields
 * @returns {Record<string, string>}
 */
function buildDocFields(hashData, fieldMap, schemaFields) {
  const docFields = {};

  for (const [identifier, fieldName] of fieldMap.entries()) {
    docFields[fieldName] = hashData[identifier] ?? '';
  }
  for (const f of schemaFields) {
    if (!(f.name in docFields)) docFields[f.name] = '';
  }

  if (!docFields['payload']) {
    docFields['payload'] = Object.entries(docFields)
      .filter(([k]) => k !== 'payload')
      .map(([, v]) => v)
      .filter(Boolean)
      .join(' ');
  }

  return docFields;
}

/**
 * Read document score from Redis hash fields.
 * Prefers `__score`, then `score`, and falls back to `1.0`.
 *
 * @param {Record<string, string>} hashData
 * @returns {number}
 */
function getDocScore(hashData) {
  const rawScore = hashData['__score'] ?? hashData['score'];
  return rawScore ? (parseFloat(rawScore) || 1.0) : 1.0;
}

/**
 * Import suggestions from a RediSearch index via FT.SUGGET "" MAX n WITHSCORES.
 * RediSearch has no cursor for FT.SUGGET; maxSuggestions caps the import.
 * Returns the number of suggestions imported.
 *
 * @param {import('redis').RedisClientType} redisClient
 * @param {import('better-sqlite3').Database} db
 * @param {string} indexName
 * @param {number} maxSuggestions
 * @returns {Promise<number>}
 */
async function importSuggestions(redisClient, db, indexName, maxSuggestions) {
  try {
    const raw = await redisClient.sendCommand([
      'FT.SUGGET', indexName, '', 'MAX', String(maxSuggestions), 'WITHSCORES',
    ]);
    if (!Array.isArray(raw) || raw.length === 0) return 0;

    let count = 0;
    // Response alternates [term, score, term, score, …]
    db.transaction(() => {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const term  = String(raw[i]);
        const score = parseFloat(String(raw[i + 1])) || 1.0;
        try {
          suggestionAdd(db, indexName, term, score, false, undefined);
          count++;
        } catch (_) {}
      }
    })();
    return count;
  } catch (_) {
    return 0;
  }
}

/**
 * Migrate all (or selected) RediSearch indices from a Redis source into the RespLite DB.
 *
 * On SIGINT/SIGTERM: finish the current document, then stop gracefully.
 * DB is always closed in a finally block.
 *
 * @param {import('redis').RedisClientType} redisClient
 * @param {string} dbPath
 * @param {object} [options]
 * @param {string}   [options.pragmaTemplate='default']
 * @param {string[]} [options.onlyIndices]         - Restrict to these index names.
 * @param {number}   [options.scanCount=500]        - COUNT hint for SCAN.
 * @param {number}   [options.maxRps=0]             - Max Redis requests/s (0 = unlimited).
 * @param {number}   [options.batchDocs=200]        - Docs per SQLite transaction.
 * @param {number}   [options.maxSuggestions=10000] - Cap for FT.SUGGET import.
 * @param {boolean}  [options.skipExisting=true]    - Reuse an existing destination index and skip FT.CREATE instead of failing.
 * @param {boolean}  [options.withSuggestions=true] - Also migrate suggestions.
 * @param {(result: IndexResult) => void} [options.onProgress]
 * @returns {Promise<{ indices: IndexResult[], aborted: boolean }>}
 */
export async function runMigrateSearch(redisClient, dbPath, options = {}) {
  const {
    pragmaTemplate  = 'default',
    onlyIndices     = null,
    scanCount       = 500,
    maxRps          = 0,
    batchDocs       = 200,
    maxSuggestions  = 10000,
    skipExisting    = true,
    withSuggestions = true,
    onProgress,
  } = options;

  const db = openDb(dbPath, { pragmaTemplate });
  let abortRequested = false;
  const onSignal = () => { abortRequested = true; };
  process.on('SIGINT',  onSignal);
  process.on('SIGTERM', onSignal);

  const minIntervalMs = maxRps > 0 ? 1000 / maxRps : 0;
  let lastKeyTime = 0;

  async function throttle() {
    if (minIntervalMs <= 0) return;
    const elapsed = Date.now() - lastKeyTime;
    if (elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed);
    lastKeyTime = Date.now();
  }

  try {
    const allNames = await listSearchIndices(redisClient);
    const targets  = onlyIndices
      ? allNames.filter((n) => onlyIndices.includes(n))
      : allNames;

    const results = [];

    for (const indexName of targets) {
      if (abortRequested) break;

      // ── Validate name ────────────────────────────────────────────────
      if (!INDEX_NAME_RE.test(indexName)) {
        results.push(errorResult(indexName, `Index name "${indexName}" is not valid in RespLite (must match [A-Za-z][A-Za-z0-9:_-]{0,63})`));
        continue;
      }

      // ── Step 1: FT.INFO ──────────────────────────────────────────────
      let info;
      try {
        info = await getSearchIndexInfo(redisClient, indexName);
      } catch (e) {
        results.push(errorResult(indexName, `FT.INFO failed: ${e.message}`));
        continue;
      }

      if (info.keyType !== 'HASH') {
        results.push(errorResult(indexName, `key_type "${info.keyType}" not supported (only HASH)`));
        continue;
      }

      // ── Step 2: map schema ────────────────────────────────────────────
      const { fields, fieldMap, warnings } = mapFields(info.attributes);

      // ── Step 3: FT.CREATE ─────────────────────────────────────────────
      let created = false;
      let skipped = false;
      try {
        createIndex(db, indexName, fields);
        created = true;
      } catch (e) {
        if (e.message.includes('already exists')) {
          if (skipExisting) {
            skipped = true;
            warnings.push(`Index "${indexName}" already exists in destination; reusing existing schema`);
          } else {
            results.push({ ...errorResult(indexName, 'Index already exists in destination'), warnings });
            continue;
          }
        } else {
          results.push({ ...errorResult(indexName, `FT.CREATE failed: ${e.message}`), warnings });
          continue;
        }
      }

      // ── Step 4: import documents ──────────────────────────────────────
      let docsImported = 0;
      let docsSkipped  = 0;
      let docErrors    = 0;
      const seenKeys = new Set();

      // Batch infrastructure: accumulate HGETALL results, flush in SQLite transactions
      const pendingHashData = new Map();
      let pendingKeys = [];

      const batchInsert = db.transaction((keyBatch) => {
        for (const key of keyBatch) {
          const hashData = pendingHashData.get(key);
          if (!hashData) continue;
          const docFields = buildDocFields(hashData, fieldMap, fields);
          const score = getDocScore(hashData);
          addDocument(db, indexName, key, score, true, docFields);
        }
      });

      const flushBatch = () => {
        if (pendingKeys.length === 0) return;
        const flushKeys = pendingKeys.splice(0);
        try {
          batchInsert(flushKeys);
          docsImported += flushKeys.length;
        } catch (_) {
          // batch failed — fall back to one-by-one to minimise data loss
          for (const k of flushKeys) {
            try {
              const hd = pendingHashData.get(k);
              if (!hd) continue;
              addDocument(db, indexName, k, getDocScore(hd), true, buildDocFields(hd, fieldMap, fields));
              docsImported++;
            } catch (_e) {
              docErrors++;
            }
          }
        }
        pendingHashData.clear();
      };

      for (const prefix of info.prefixes) {
        if (abortRequested) break;
        const matchPattern = prefix ? `${prefix}*` : '*';
        let cursor = 0;

        do {
          if (abortRequested) break;
          await throttle();

          const scanResult = await redisClient.scan(cursor, { MATCH: matchPattern, COUNT: scanCount });
          cursor = Array.isArray(scanResult)
            ? parseInt(String(scanResult[0]), 10)
            : (scanResult?.cursor ?? 0);
          const pageKeys = Array.isArray(scanResult) ? scanResult[1] : (scanResult?.keys ?? []);

          for (const key of pageKeys) {
            if (abortRequested) break;
            await throttle();

            let hashData;
            try {
              hashData = await redisClient.hGetAll(key);
            } catch (_) {
              docErrors++;
              continue;
            }

            if (seenKeys.has(key)) {
              continue;
            }

            if (!hashData || typeof hashData !== 'object' || Object.keys(hashData).length === 0) {
              seenKeys.add(key);
              docsSkipped++;
              continue;
            }

            seenKeys.add(key);
            pendingHashData.set(key, hashData);
            pendingKeys.push(key);

            if (pendingKeys.length >= batchDocs) flushBatch();
          }
        } while (cursor !== 0 && !abortRequested);
      }
      flushBatch(); // flush remainder

      // ── Step 5: suggestions ───────────────────────────────────────────
      let sugsImported = 0;
      if (withSuggestions && !abortRequested) {
        sugsImported = await importSuggestions(redisClient, db, indexName, maxSuggestions);
      }

      const result = {
        name: indexName,
        created,
        skipped,
        docsImported,
        docsSkipped,
        docErrors,
        sugsImported,
        warnings,
      };
      results.push(result);
      if (onProgress) onProgress(result);
    }

    return { indices: results, aborted: abortRequested };
  } finally {
    process.off('SIGINT',  onSignal);
    process.off('SIGTERM', onSignal);
    db.close();
  }
}

/** @param {string} name @param {string} error */
function errorResult(name, error) {
  return { name, created: false, skipped: false, docsImported: 0, docsSkipped: 0, docErrors: 0, sugsImported: 0, warnings: [], error };
}

// ── Exported helpers (used by tests) ─────────────────────────────────────────
export { mapFields, buildDocFields, getDocScore };
