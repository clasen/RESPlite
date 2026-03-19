/**
 * FT.GET index doc_id — return document fields as a flat array [field, value, ...] or nil if missing.
 * Matches RediSearch: single doc by id; unknown index errors; not indexed returns null.
 */

import { parseFtGet } from './ft/parser.js';
import { getDocumentFields } from '../storage/sqlite/search.js';

export function handleFtGet(engine, args) {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtGet(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const fields = getDocumentFields(db, parsed.indexName, parsed.docId);
    return fields;
  } catch (e) {
    const msg = e?.message ?? String(e);
    return { error: msg === 'Unknown index name' ? msg : msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
