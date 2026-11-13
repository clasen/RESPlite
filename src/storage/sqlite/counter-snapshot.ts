/**
 * Snapshot of the in-memory row counters (DBSIZE, FT.INFO), so a clean restart does
 * not have to count every key and index again.
 *
 * Every connection claims (reads and deletes) the snapshot when it opens the database,
 * so a process that exits without saving leaves none and the next open counts. Only a
 * server saves one, when it closes, after revalidating its counters against commits
 * made by other connections.
 */

import type Database from './driver.ts';

export const COUNTER_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS resplite_counter_snapshot (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

interface ClaimedSnapshot {
  /** PRAGMA data_version right after the claim; values are stale once it changes. */
  dataVersion: number;
  values: Map<string, number>;
}

/** Current counter values of one source, read only when a snapshot is saved. */
type CounterSource = () => Iterable<[string, number]>;

const claimed = new WeakMap<Database, ClaimedSnapshot>();
const sources = new WeakMap<Database, CounterSource[]>();

/**
 * Read and delete the stored snapshot. Called once by openDb, before any other write.
 */
export function claimCounterSnapshot(db: Database): void {
  const rows: { name: string; value: number }[] = db.transaction(() => {
    const found = db.prepare('SELECT name, value FROM resplite_counter_snapshot').all();
    if (found.length > 0) db.prepare('DELETE FROM resplite_counter_snapshot').run();
    return found;
  }).immediate();
  if (rows.length === 0) return;
  claimed.set(db, {
    dataVersion: db.prepare('PRAGMA data_version').pluck().get(),
    values: new Map(rows.map((r) => [r.name, r.value])),
  });
}

/**
 * Take a value from the claimed snapshot. Returns undefined when there is none or when
 * another connection has committed since the claim (currentDataVersion differs).
 * Each value is handed out once.
 */
export function takeSnapshotValue(db: Database, name: string, currentDataVersion: number): number | undefined {
  const snapshot = claimed.get(db);
  if (!snapshot) return undefined;
  if (snapshot.dataVersion !== currentDataVersion) {
    claimed.delete(db);
    return undefined;
  }
  const value = snapshot.values.get(name);
  snapshot.values.delete(name);
  return value;
}

/** Drop snapshot values whose name starts with prefix (their data was replaced). */
export function discardSnapshotValues(db: Database, prefix: string): void {
  const snapshot = claimed.get(db);
  if (!snapshot) return;
  for (const name of [...snapshot.values.keys()]) {
    if (name.startsWith(prefix)) snapshot.values.delete(name);
  }
}

/** Register a counter source to include when this connection saves a snapshot. */
export function registerCounterSource(db: Database, source: CounterSource): void {
  const list = sources.get(db);
  if (list) list.push(source);
  else sources.set(db, [source]);
}

/**
 * Store the current counters. Call right before closing the database on a clean shutdown.
 */
export function saveCounterSnapshot(db: Database): void {
  const entries: [string, number][] = [];
  for (const source of sources.get(db) ?? []) entries.push(...source());
  db.transaction(() => {
    db.prepare('DELETE FROM resplite_counter_snapshot').run();
    const insert = db.prepare('INSERT INTO resplite_counter_snapshot(name, value) VALUES (?, ?)');
    for (const [name, value] of entries) insert.run(name, value);
  }).immediate();
}
