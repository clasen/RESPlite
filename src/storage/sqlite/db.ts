/**
 * Open SQLite database, apply pragmas and schema.
 * If the path points to a file in a directory that does not exist, the directory is created.
 */

import Database from './driver.ts';
import type { DatabaseSyncOptions } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { applyPragmas } from './pragmas.ts';
import { applySchema } from './schema.ts';
import { applyMigrationSchema } from './migration-schema.ts';

/**
 * Options: pragmaTemplate (default|performance|safety|minimal), pragma (custom key-value overrides), plus any node:sqlite DatabaseSync options.
 */
export interface OpenDbOptions extends DatabaseSyncOptions {
  pragmaTemplate?: string;
  pragma?: Record<string, string | number>;
}

/**
 * @param dbPath - Database file path (or ':memory:')
 */
export function openDb(dbPath: string, options: OpenDbOptions = {}): Database {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }
  const { pragmaTemplate = 'default', pragma: customPragma, ...dbOptions } = options;
  const db = new Database(dbPath, dbOptions);
  applyPragmas(db, pragmaTemplate, customPragma);
  applySchema(db);
  applyMigrationSchema(db);
  return db;
}
