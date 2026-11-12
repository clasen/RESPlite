/**
 * FT.DEL index doc_id
 */

import { parseFtDel } from './ft/parser.ts';
import { deleteDocument } from '../storage/sqlite/search.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleFtDel(engine: Engine, args: Buffer[]): CommandReply {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtDel(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const n = deleteDocument(db, parsed.indexName, parsed.docId);
    return n;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg === 'Unknown index name' ? msg : msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
