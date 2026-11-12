/**
 * FT.SUGDEL index string
 */

import { parseFtSugdel } from './ft/parser.ts';
import { suggestionDel } from '../storage/sqlite/search.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleFtSugdel(engine: Engine, args: Buffer[]): CommandReply {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtSugdel(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const n = suggestionDel(db, parsed.indexName, parsed.term);
    return n;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg === 'Unknown index name' ? msg : msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
