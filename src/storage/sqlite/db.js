/**
 * Open SQLite database, apply pragmas and schema.
 */

import Database from 'better-sqlite3';
import { applyPragmas } from './pragmas.js';
import { applySchema } from './schema.js';

/**
 * @param {string} path - Database file path
 * @param {object} [options] - Options: pragmaTemplate (default|performance|safety|minimal), plus any better-sqlite3 options
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(path, options = {}) {
  const { pragmaTemplate = 'default', ...dbOptions } = options;
  const db = new Database(path, dbOptions);
  applyPragmas(db, pragmaTemplate);
  applySchema(db);
  return db;
}
