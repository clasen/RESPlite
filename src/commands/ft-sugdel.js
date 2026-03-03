/**
 * FT.SUGDEL index string
 */

import { parseFtSugdel } from './ft/parser.js';
import { suggestionDel } from '../storage/sqlite/search.js';

export function handleFtSugdel(engine, args) {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtSugdel(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const n = suggestionDel(db, parsed.indexName, parsed.term);
    return n;
  } catch (e) {
    const msg = e?.message ?? String(e);
    return { error: msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
