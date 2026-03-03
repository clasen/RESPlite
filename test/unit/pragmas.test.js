import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/storage/sqlite/db.js';
import { getPragmaTemplateNames, getPragmasForTemplate } from '../../src/storage/sqlite/pragmas.js';
import { tmpDbPath } from '../helpers/tmp.js';

describe('Pragma templates', () => {
  it('getPragmaTemplateNames returns all template names', () => {
    const names = getPragmaTemplateNames();
    assert.deepEqual(names.sort(), ['default', 'minimal', 'none', 'performance', 'safety']);
  });

  it('getPragmasForTemplate returns array for known template', () => {
    const pragmas = getPragmasForTemplate('default');
    assert.ok(Array.isArray(pragmas));
    assert.ok(pragmas.length > 0);
    assert.ok(pragmas.every((s) => typeof s === 'string' && s.startsWith('PRAGMA ')));
  });

  it('getPragmasForTemplate falls back to default for unknown name', () => {
    const unknown = getPragmasForTemplate('unknown');
    const def = getPragmasForTemplate('default');
    assert.deepEqual(unknown, def);
  });

  it('openDb with default template applies synchronous=NORMAL', () => {
    const path = tmpDbPath();
    const db = openDb(path, { pragmaTemplate: 'default' });
    try {
      const row = db.prepare('PRAGMA synchronous').get();
      assert.equal(row.synchronous, 1); // NORMAL = 1 in SQLite
    } finally {
      db.close();
    }
  });

  it('openDb with safety template applies synchronous=FULL', () => {
    const path = tmpDbPath();
    const db = openDb(path, { pragmaTemplate: 'safety' });
    try {
      const row = db.prepare('PRAGMA synchronous').get();
      assert.equal(row.synchronous, 2); // FULL = 2 in SQLite
    } finally {
      db.close();
    }
  });

  it('openDb with minimal template applies fewer pragmas', () => {
    const path = tmpDbPath();
    const db = openDb(path, { pragmaTemplate: 'minimal' });
    try {
      const journal = db.prepare('PRAGMA journal_mode').get();
      assert.equal(journal.journal_mode, 'wal');
    } finally {
      db.close();
    }
  });

  it('none template applies zero pragmas', () => {
    const pragmas = getPragmasForTemplate('none');
    assert.ok(Array.isArray(pragmas));
    assert.equal(pragmas.length, 0);
  });

  it('openDb with none template uses SQLite defaults', () => {
    const path = tmpDbPath();
    const db = openDb(path, { pragmaTemplate: 'none' });
    try {
      const row = db.prepare('PRAGMA journal_mode').get();
      assert.equal(row.journal_mode, 'delete'); // SQLite default
    } finally {
      db.close();
    }
  });
});
