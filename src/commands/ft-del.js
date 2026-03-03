/**
 * FT.DEL index doc_id
 */

import { parseFtDel } from './ft/parser.js';
import { deleteDocument } from '../storage/sqlite/search.js';

export function handleFtDel(engine, args) {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtDel(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const n = deleteDocument(db, parsed.indexName, parsed.docId);
    return n;
  } catch (e) {
    const msg = e?.message ?? String(e);
    return { error: msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
