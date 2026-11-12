/**
 * FT.ADD index doc_id score [REPLACE] FIELDS field value [field value ...]
 */

import { parseFtAdd } from './ft/parser.ts';
import { getIndexMeta, addDocument } from '../storage/sqlite/search.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleFtAdd(engine: Engine, args: Buffer[]): CommandReply {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtAdd(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const meta = getIndexMeta(db, parsed.indexName);
    const schemaNames = meta.schema.fields.map((f: { name: string; type: string }) => f.name);
    for (const name of Object.keys(parsed.fields)) {
      if (!schemaNames.includes(name)) return { error: 'ERR unknown field' };
    }
    addDocument(db, parsed.indexName, parsed.docId, parsed.score, parsed.replace, parsed.fields);
    return { simple: 'OK' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg === 'Unknown index name' ? msg : msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
