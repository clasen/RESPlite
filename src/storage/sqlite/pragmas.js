/**
 * SQLite pragmas for RESPLite workload (per SPEC section 15).
 * Templates: default, performance, safety, minimal, none.
 *
 * Templates are composed from a shared base to avoid duplication.
 * Values use numeric separators / expressions so units are obvious.
 */

const KB = 1024;
const MB = 1024 * KB;

const BASE = {
  journal_mode: 'WAL',
  foreign_keys: 'ON',
  temp_store: 'MEMORY',
  busy_timeout: 5_000,           // ms — avoids SQLITE_BUSY under concurrency
  wal_autocheckpoint: 1_000,     // pages
};

const TEMPLATES = {
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

function toSqlStatements(obj) {
  return Object.entries(obj).map(
    ([key, val]) => `PRAGMA ${key}=${val};`,
  );
}

export const PRAGMA_TEMPLATES = Object.fromEntries(
  Object.entries(TEMPLATES).map(([name, cfg]) => [name, toSqlStatements(cfg)]),
);

/**
 * @returns {string[]} Template names
 */
export function getPragmaTemplateNames() {
  return Object.keys(PRAGMA_TEMPLATES);
}

/**
 * @param {string} name - Template name
 * @returns {string[]} Array of PRAGMA SQL strings
 */
export function getPragmasForTemplate(name) {
  return PRAGMA_TEMPLATES[name] ?? PRAGMA_TEMPLATES.default;
}

/**
 * Apply pragmas from a named template to an open database.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [templateName='default'] - One of: default, performance, safety, minimal, none
 */
export function applyPragmas(db, templateName = 'default') {
  const pragmas = getPragmasForTemplate(templateName);
  for (const sql of pragmas) {
    db.exec(sql);
  }
}
