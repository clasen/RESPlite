/**
 * FT.SUGGET index prefix [FUZZY] [MAX n] [WITHSCORES] [WITHPAYLOADS]
 */

import { parseFtSugget } from './ft/parser.ts';
import { suggestionGet } from '../storage/sqlite/search.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleFtSugget(engine: Engine, args: Buffer[]): CommandReply {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtSugget(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const list = suggestionGet(db, parsed.indexName, parsed.prefix, {
      max: parsed.max,
      withScores: parsed.withScores,
      withPayloads: parsed.withPayloads,
    });
    return list;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg === 'Unknown index name' ? msg : msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
