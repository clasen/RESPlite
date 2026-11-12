/**
 * FT.CREATE index SCHEMA field type [field type ...]
 */

import { parseFtCreate } from './ft/parser.ts';
import { createIndex } from '../storage/sqlite/search.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleFtCreate(engine: Engine, args: Buffer[]): CommandReply {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtCreate(args);
  if (parsed.error) return { error: parsed.error };
  try {
    createIndex(db, parsed.indexName, parsed.fields);
    return { simple: 'OK' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg === 'Unknown index name' ? msg : msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
