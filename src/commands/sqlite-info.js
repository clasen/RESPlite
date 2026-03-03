/**
 * SQLITE.INFO - operational info: path, version, counts by type, WAL.
 */

export function handleSqliteInfo(engine, args) {
  const db = engine._db;
  if (!db) return { error: 'ERR SQLite not available' };
  const keys = engine._keys;
  const path = db.name || '';
  const versionRow = db.prepare('SELECT sqlite_version() AS v').get();
  const version = versionRow ? versionRow.v : '';
  const total = keys.count();
  const byType = db.prepare('SELECT type, COUNT(*) AS n FROM redis_keys GROUP BY type').all();
  const stringCount = byType.find((r) => r.type === 1)?.n ?? 0;
  const hashCount = byType.find((r) => r.type === 2)?.n ?? 0;
  const setCount = byType.find((r) => r.type === 3)?.n ?? 0;
  const listCount = byType.find((r) => r.type === 4)?.n ?? 0;
  let journalMode = 'unknown';
  try {
    const walRow = db.prepare('PRAGMA journal_mode').get();
    journalMode = (walRow && (walRow.journal_mode || Object.values(walRow)[0])) || 'unknown';
  } catch (_) {}
  const info = [
    'path',
    path,
    'version',
    version,
    'total_keys',
    String(total),
    'string_keys',
    String(stringCount),
    'hash_keys',
    String(hashCount),
    'set_keys',
    String(setCount),
    'list_keys',
    String(listCount),
    'journal_mode',
    journalMode,
  ];
  return info;
}
