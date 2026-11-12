/**
 * FT.INFO index
 */

import { parseFtInfo } from './ft/parser.ts';
import { getIndexMeta, getIndexCounts } from '../storage/sqlite/search.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleFtInfo(engine: Engine, args: Buffer[]): CommandReply {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtInfo(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const meta = getIndexMeta(db, parsed.indexName);
    const counts = getIndexCounts(db, parsed.indexName);
    const fields = meta.schema.fields.map((f: { name: string; type: string }) => f.name);
    return [
      'index_name',
      meta.name,
      'fields',
      fields,
      'num_docs',
      counts.num_docs,
      'fts_rows',
      counts.fts_rows,
      'num_suggestions',
      counts.num_suggestions,
      'created_at',
      meta.created_at,
      'updated_at',
      meta.updated_at,
    ];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg === 'Unknown index name' ? msg : msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
