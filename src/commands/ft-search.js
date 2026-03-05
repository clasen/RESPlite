/**
 * FT.SEARCH index query [NOCONTENT] [LIMIT offset count]
 */

import { parseFtSearch } from './ft/parser.js';
import { search } from '../storage/sqlite/search.js';

export function handleFtSearch(engine, args) {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const parsed = parseFtSearch(args);
  if (parsed.error) return { error: parsed.error };
  try {
    const result = search(db, parsed.indexName, parsed.query, {
      offset: parsed.offset,
      count: parsed.count,
      noContent: parsed.noContent,
    });
    const out = [result.total];
    if (parsed.noContent) {
      out.push(...result.docIds);
    } else {
      for (const docId of result.docIds) {
        out.push(docId);
        const fields = result.fieldsByDoc[docId] ?? {};
        const flat = [];
        for (const [k, v] of Object.entries(fields)) {
          flat.push(k, v);
        }
        out.push(flat);
      }
    }
    return out;
  } catch (e) {
    const msg = e?.message ?? String(e);
    return { error: msg === 'Unknown index name' ? msg : msg.startsWith('ERR ') ? msg : 'ERR ' + msg };
  }
}
