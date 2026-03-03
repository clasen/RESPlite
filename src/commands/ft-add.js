/**
 * FT.ADD index doc_id score [REPLACE] FIELDS field value [field value ...]
 */

import { parseFtAdd } from './ft/parser.js';
import { getIndexMeta, addDocument } from '../storage/sqlite/search.js';

export function handleFtAdd(engine, args) {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtAdd(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const meta = getIndexMeta(db, parsed.indexName);
    const schemaNames = meta.schema.fields.map((f) => f.name);
    for (const name of Object.keys(parsed.fields)) {
      if (!schemaNames.includes(name)) return { error: 'ERR unknown field' };
    }
    addDocument(db, parsed.indexName, parsed.docId, parsed.score, parsed.replace, parsed.fields);
    return { simple: 'OK' };
  } catch (e) {
    const msg = e?.message ?? String(e);
    return { error: msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
