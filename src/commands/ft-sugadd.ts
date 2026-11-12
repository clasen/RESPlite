/**
 * FT.SUGADD index string score [INCR] [PAYLOAD payload]
 */

import { parseFtSugadd } from './ft/parser.ts';
import { suggestionAdd } from '../storage/sqlite/search.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleFtSugadd(engine: Engine, args: Buffer[]): CommandReply {
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
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg === 'Unknown index name' ? msg : msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
