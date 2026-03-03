/**
 * Schema for redis_keys, redis_strings, redis_hashes, redis_sets (SPEC section 10).
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS redis_keys (
  key BLOB PRIMARY KEY,
  type INTEGER NOT NULL,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS redis_keys_expires_at_idx ON redis_keys(expires_at);
CREATE INDEX IF NOT EXISTS redis_keys_type_idx ON redis_keys(type);

CREATE TABLE IF NOT EXISTS redis_strings (
  key BLOB PRIMARY KEY,
  value BLOB NOT NULL,
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS redis_hashes (
  key BLOB NOT NULL,
  field BLOB NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (key, field),
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS redis_sets (
  key BLOB NOT NULL,
  member BLOB NOT NULL,
  PRIMARY KEY (key, member),
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS redis_list_meta (
  key BLOB PRIMARY KEY,
  head_seq INTEGER NOT NULL,
  tail_seq INTEGER NOT NULL,
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS redis_list_items (
  key BLOB NOT NULL,
  seq INTEGER NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (key, seq),
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS redis_list_items_key_seq_idx ON redis_list_items(key, seq);

CREATE TABLE IF NOT EXISTS redis_zsets (
  key BLOB NOT NULL,
  member BLOB NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (key, member),
  FOREIGN KEY(key) REFERENCES redis_keys(key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS redis_zsets_key_score_member_idx
  ON redis_zsets(key, score, member);

CREATE TABLE IF NOT EXISTS search_indices (
  name TEXT PRIMARY KEY,
  schema_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Type enum: 1=string, 2=hash, 3=set, 4=list, 5=zset */
export const KEY_TYPES = {
  STRING: 1,
  HASH: 2,
  SET: 3,
  LIST: 4,
  ZSET: 5,
};

/**
 * Apply schema to database.
 * @param {import('better-sqlite3').Database} db
 */
export function applySchema(db) {
  db.exec(SCHEMA);
}
