/**
 * FT.SUGADD index string score [INCR] [PAYLOAD payload]
 */

import { parseFtSugadd } from './ft/parser.js';
import { suggestionAdd } from '../storage/sqlite/search.js';

export function handleFtSugadd(engine, args) {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtSugadd(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const n = suggestionAdd(
      db,
      parsed.indexName,
      parsed.term,
      parsed.score,
      parsed.incr,
      parsed.payload
    );
    return n;
  } catch (e) {
    const msg = e?.message ?? String(e);
    return { error: msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
