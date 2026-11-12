/**
 * SQLite pragmas for RESPLite workload (per SPEC section 15).
 * Templates: default, performance, safety, minimal, none.
 *
 * Templates are composed from a shared base to avoid duplication.
 * Values use numeric separators / expressions so units are obvious.
 */

import type Database from './driver.ts';

const KB = 1024;
const MB = 1024 * KB;

const BASE: Record<string, string | number> = {
  journal_mode: 'WAL',
  foreign_keys: 'ON',
  temp_store: 'MEMORY',
  busy_timeout: 5_000,           // ms — avoids SQLITE_BUSY under concurrency
  wal_autocheckpoint: 1_000,     // pages
};

const TEMPLATES: Record<string, Record<string, string | number>> = {
  default: {
    ...BASE,
    synchronous: 'NORMAL',
    cache_size: -20_000,          // ~20 MB (negative = KiB)
  },
  performance: {
    ...BASE,
    synchronous: 'OFF',
    cache_size: -64_000,          // ~64 MB
    mmap_size: 512 * MB,
    wal_autocheckpoint: 2_000,
    locking_mode: 'EXCLUSIVE',   // eliminates shared-lock overhead
  },
  safety: {
    ...BASE,
    synchronous: 'FULL',
    cache_size: -20_000,
  },
  minimal: {
    journal_mode: 'WAL',
    foreign_keys: 'ON',
  },
  none: {},
};

function toSqlStatements(obj: Record<string, string | number>): string[] {
  return Object.entries(obj).map(
    ([key, val]) => `PRAGMA ${key}=${val};`,
  );
}

export const PRAGMA_TEMPLATES: Record<string, string[]> = Object.fromEntries(
  Object.entries(TEMPLATES).map(([name, cfg]) => [name, toSqlStatements(cfg)]),
);

/**
 * @returns Template names
 */
export function getPragmaTemplateNames(): string[] {
  return Object.keys(PRAGMA_TEMPLATES);
}

/**
 * @param name - Template name
 * @returns Array of PRAGMA SQL strings
 */
export function getPragmasForTemplate(name: string): string[] {
  return PRAGMA_TEMPLATES[name] ?? PRAGMA_TEMPLATES.default;
}

/**
 * Apply custom pragma key-value object to an open database.
 * @param obj - e.g. { journal_mode: 'WAL', cache_size: -64000 }
 */
function applyPragmaObject(db: Database, obj: Record<string, string | number | undefined>): void {
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    db.exec(`PRAGMA ${key}=${val};`);
  }
}

/**
 * Apply pragmas from a named template and optional overrides to an open database.
 * @param templateName - One of: default, performance, safety, minimal, none
 * @param customPragma - Optional overrides, e.g. { synchronous: 'FULL', cache_size: -10000 }
 */
export function applyPragmas(
  db: Database,
  templateName: string = 'default',
  customPragma: Record<string, string | number | undefined> | undefined = undefined,
): void {
  const pragmas = getPragmasForTemplate(templateName);
  for (const sql of pragmas) {
    db.exec(sql);
  }
  if (customPragma && typeof customPragma === 'object' && Object.keys(customPragma).length > 0) {
    applyPragmaObject(db, customPragma);
  }
}
