/**
 * FT.CREATE index SCHEMA field type [field type ...]
 */

import { parseFtCreate } from './ft/parser.js';
import { createIndex } from '../storage/sqlite/search.js';

export function handleFtCreate(engine, args) {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtCreate(args);
  if (parsed.error) return { error: parsed.error };
  try {
    createIndex(db, parsed.indexName, parsed.fields);
    return { simple: 'OK' };
  } catch (e) {
    const msg = e?.message ?? String(e);
    return { error: msg === 'Unknown index name' ? msg : msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
