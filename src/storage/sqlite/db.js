/**
 * Open SQLite database, apply pragmas and schema.
 * If the path points to a file in a directory that does not exist, the directory is created.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { applyPragmas } from './pragmas.js';
import { applySchema } from './schema.js';
import { applyMigrationSchema } from './migration-schema.js';

/**
 * @param {string} dbPath - Database file path (or ':memory:')
 * @param {object} [options] - Options: pragmaTemplate (default|performance|safety|minimal), plus any better-sqlite3 options
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(dbPath, options = {}) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }
  const { pragmaTemplate = 'default', ...dbOptions } = options;
  const db = new Database(dbPath, dbOptions);
  applyPragmas(db, pragmaTemplate);
  applySchema(db);
  applyMigrationSchema(db);
  return db;
}
