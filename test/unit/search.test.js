import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/storage/sqlite/db.ts';
import {
  createIndex,
  getIndexMeta,
  getIndexCounts,
  addDocument,
  getDocumentFields,
  deleteDocument,
  search,
  suggestionAdd,
  suggestionGet,
  suggestionDel,
  validateIndexName,
  resolveSearchLimits,
  SearchTimeoutError,
} from '../../src/storage/sqlite/search.ts';
import { tmpDbPath } from '../helpers/tmp.js';

describe('Search layer', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  it('validateIndexName rejects invalid names', () => {
    assert.throws(() => validateIndexName(''), /invalid index name/);
    assert.throws(() => validateIndexName('1abc'), /invalid index name/);
    assert.throws(() => validateIndexName('a'.repeat(65)), /invalid index name/);
    assert.throws(() => validateIndexName('idx space'), /invalid index name/);
    validateIndexName('names');
    validateIndexName('idx_1');
    validateIndexName('My-Index:test');
  });

  it('createIndex creates tables and rejects duplicate', () => {
    createIndex(db, 'names', [{ name: 'payload', type: 'TEXT' }]);
    const meta = getIndexMeta(db, 'names');
    assert.equal(meta.name, 'names');
    assert.deepEqual(meta.schema.fields, [{ name: 'payload', type: 'TEXT' }]);
    assert.throws(() => createIndex(db, 'names', [{ name: 'payload', type: 'TEXT' }]), /index already exists/);
  });

  it('createIndex requires payload TEXT', () => {
    assert.throws(() => createIndex(db, 'bad1', [{ name: 'title', type: 'TEXT' }]), /payload field required/);
    assert.throws(() => createIndex(db, 'bad2', []), /syntax error/);
  });

  it('addDocument inserts and REPLACE updates', () => {
    addDocument(db, 'names', 'doc1', 1.0, true, { payload: 'hello world' });
    const r = search(db, 'names', 'hello', { noContent: true });
    assert.equal(r.total, 1);
    assert.deepEqual(r.docIds, ['doc1']);

    addDocument(db, 'names', 'doc1', 2.0, true, { payload: 'hello updated' });
    const r2 = search(db, 'names', 'updated', { noContent: true });
    assert.equal(r2.total, 1);
    assert.equal(r2.docIds[0], 'doc1');
  });

  it('addDocument without REPLACE on existing doc throws', () => {
    addDocument(db, 'names', 'doc2', 1, true, { payload: 'foo' });
    assert.throws(() => addDocument(db, 'names', 'doc2', 1, false, { payload: 'bar' }), /document exists/);
  });

  it('addDocument unknown field throws', () => {
    assert.throws(() => addDocument(db, 'names', 'doc3', 1, true, { payload: 'x', unknown: 'y' }), /unknown field/);
  });

  it('getDocumentFields returns null when doc missing, flat array in schema order', () => {
    assert.equal(getDocumentFields(db, 'names', 'no-such-doc'), null);
    addDocument(db, 'names', 'gd1', 1, true, { payload: 'hello' });
    assert.deepEqual(getDocumentFields(db, 'names', 'gd1'), ['payload', 'hello']);
    addDocument(db, 'names', 'gd2', 1, true, { payload: '' });
    assert.deepEqual(getDocumentFields(db, 'names', 'gd2'), ['payload', null]);
  });

  it('getDocumentFields multi-field schema order', () => {
    createIndex(db, 'mf', [
      { name: 'payload', type: 'TEXT' },
      { name: 'title', type: 'TEXT' },
    ]);
    addDocument(db, 'mf', 'm1', 1, true, { payload: 'pval', title: 'tval' });
    assert.deepEqual(getDocumentFields(db, 'mf', 'm1'), ['payload', 'pval', 'title', 'tval']);
  });

  it('deleteDocument returns 1 when found, 0 when not', () => {
    addDocument(db, 'names', 'todel', 1, true, { payload: 'to delete' });
    assert.equal(deleteDocument(db, 'names', 'todel'), 1);
    assert.equal(search(db, 'names', 'delete', { noContent: true }).total, 0);
    assert.equal(deleteDocument(db, 'names', 'nonexistent'), 0);
  });

  it('delete + re-add never remaps legacy stale tokens', () => {
    createIndex(db, 'legacy_stale', [{ name: 'payload', type: 'TEXT' }]);
    addDocument(db, 'legacy_stale', 'doc1', 1, true, { payload: 'gorrion' });

    const mapped = db
      .prepare('SELECT fts_rowid FROM search_docmap__legacy_stale WHERE doc_id = ?')
      .get('doc1');
    const oldRowid = mapped.fts_rowid;

    // Simulate a legacy-polluted index row where stale term postings exist for the same rowid.
    db.prepare('INSERT INTO search_fts__legacy_stale(rowid, payload) VALUES (?, ?)').run(oldRowid, 'bicho');

    assert.equal(search(db, 'legacy_stale', 'bicho*', { noContent: true }).total, 1);
    assert.equal(deleteDocument(db, 'legacy_stale', 'doc1'), 1);

    addDocument(db, 'legacy_stale', 'doc1', 1, true, { payload: 'gorrion' });
    const remapped = db
      .prepare('SELECT fts_rowid FROM search_docmap__legacy_stale WHERE doc_id = ?')
      .get('doc1');
    assert.notEqual(remapped.fts_rowid, oldRowid);

    assert.equal(search(db, 'legacy_stale', 'gorrion*', { noContent: true }).total, 1);
    assert.equal(search(db, 'legacy_stale', 'bicho*', { noContent: true }).total, 0);
  });

  it('allocator seeds above existing docmap rowids on legacy databases', () => {
    createIndex(db, 'legacy_seed', [{ name: 'payload', type: 'TEXT' }]);
    const docsT = 'search_docs__legacy_seed';
    const docmapT = 'search_docmap__legacy_seed';
    const ftsT = 'search_fts__legacy_seed';
    const now = Date.now();

    db.prepare(
      `INSERT INTO ${docsT}(doc_id, score, fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('old-doc', 1, JSON.stringify({ payload: 'legacy payload' }), now, now);
    db.prepare(`INSERT INTO ${docmapT}(doc_id, fts_rowid) VALUES (?, ?)`).run('old-doc', 42);
    db.prepare(`INSERT INTO ${ftsT}(rowid, payload) VALUES (?, ?)`).run(42, 'legacy payload');

    addDocument(db, 'legacy_seed', 'new-doc', 1, true, { payload: 'fresh payload' });

    const newMap = db.prepare(`SELECT fts_rowid FROM ${docmapT} WHERE doc_id = ?`).get('new-doc');
    assert.ok(newMap.fts_rowid > 42);
    assert.equal(search(db, 'legacy_seed', 'fresh*', { noContent: true }).total, 1);
  });

  it('search with NOCONTENT returns total and doc ids', () => {
    const r = search(db, 'names', 'hello', { noContent: true, offset: 0, count: 10 });
    assert.equal(typeof r.total, 'number');
    assert.ok(Array.isArray(r.docIds));
  });

  it('search without NOCONTENT returns fieldsByDoc', () => {
    const r = search(db, 'names', 'world', { noContent: false });
    assert.ok(r.fieldsByDoc);
    const ids = Object.keys(r.fieldsByDoc);
    for (const id of ids) {
      assert.ok(typeof r.fieldsByDoc[id] === 'object');
    }
  });

  it('search prefix query works', () => {
    addDocument(db, 'names', 'pfx1', 1, true, { payload: 'clasen martin' });
    const r = search(db, 'names', 'clasen*', { noContent: true });
    assert.ok(r.total >= 0);
    assert.ok(Array.isArray(r.docIds));
  });

  it('search dotted prefix query works', () => {
    addDocument(db, 'names', 'mail1', 1, true, { payload: 'martin clasen martin.clasen@gmail.com' });
    const r = search(db, 'names', 'martin.clasen*', { noContent: true });
    assert.ok(r.total >= 1);
    assert.ok(r.docIds.includes('mail1'));
  });

  it('search tokenization stays flexible across punctuation', () => {
    addDocument(db, 'names', 'chars1', 1, true, {
      payload: 'martin-clasen martin@clasen.com #martin who? alpha+beta foo/bar baz,qux',
    });
    assert.ok(search(db, 'names', 'who?', { noContent: true }).docIds.includes('chars1'));
    assert.ok(search(db, 'names', 'alpha+beta', { noContent: true }).docIds.includes('chars1'));
    assert.ok(search(db, 'names', 'foo/bar', { noContent: true }).docIds.includes('chars1'));
    assert.ok(search(db, 'names', 'baz,qux', { noContent: true }).docIds.includes('chars1'));
    assert.ok(search(db, 'names', '(martin)', { noContent: true }).docIds.includes('chars1'));
    assert.ok(search(db, 'names', '#martin*', { noContent: true }).docIds.includes('chars1'));
  });

  it('search hyphen inside term is treated as separator', () => {
    addDocument(db, 'names', 'hyphen1', 1, true, { payload: 'martin clasen' });
    const r = search(db, 'names', 'martin-clasen*', { noContent: true });
    assert.ok(r.total >= 1);
    assert.ok(r.docIds.includes('hyphen1'));
  });

  it('search leading minus uses NOT operator semantics', () => {
    addDocument(db, 'names', 'neg1', 1, true, { payload: 'martin clasen' });
    const r = search(db, 'names', 'martin -clasen*', { noContent: true });
    assert.equal(r.total, 0);
  });

  it('search invalid query throws', () => {
    assert.throws(() => search(db, 'names', ''), /invalid query/);
    assert.throws(() => search(db, 'names', 'foo"bar'), /invalid query/);
    assert.throws(() => search(db, 'names', 'martin@clasen*'), /syntax error/);
    assert.throws(() => search(db, 'names', 'martin:clasen'), /syntax error/);
  });

  it('suggestionAdd returns 1 on insert, 0 on update', () => {
    assert.equal(suggestionAdd(db, 'names', 'sug1', 10, false), 1);
    assert.equal(suggestionAdd(db, 'names', 'sug1', 5, false), 0);
    assert.equal(suggestionAdd(db, 'names', 'sug1', 3, true), 0);
  });

  it('suggestionGet returns terms by prefix', () => {
    suggestionAdd(db, 'names', 'apple', 10, false);
    suggestionAdd(db, 'names', 'apply', 5, false);
    suggestionAdd(db, 'names', 'banana', 1, false);
    const list = suggestionGet(db, 'names', 'app', { max: 5 });
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 2);
    assert.ok(list.includes('apple') || list.some((x) => (typeof x === 'string' ? x : String(x)).startsWith('app')));
  });

  it('suggestionGet WITHSCORES and WITHPAYLOADS', () => {
    suggestionAdd(db, 'names', 'scored', 42, false, 'mypayload');
    const withScores = suggestionGet(db, 'names', 'score', { max: 5, withScores: true });
    assert.ok(withScores.length >= 2);
    const withPayloads = suggestionGet(db, 'names', 'score', { max: 5, withPayloads: true });
    assert.ok(withPayloads.length >= 2);
  });

  it('suggestionDel returns 1 when deleted, 0 when not found', () => {
    suggestionAdd(db, 'names', 'todelsug', 1, false);
    assert.equal(suggestionDel(db, 'names', 'todelsug'), 1);
    assert.equal(suggestionDel(db, 'names', 'todelsug'), 0);
  });

  it('getIndexCounts returns num_docs, fts_rows, num_suggestions', () => {
    const c = getIndexCounts(db, 'names');
    assert.equal(typeof c.num_docs, 'number');
    assert.equal(typeof c.fts_rows, 'number');
    assert.equal(typeof c.num_suggestions, 'number');
  });

  it('getIndexMeta throws for unknown index', () => {
    assert.throws(() => getIndexMeta(db, 'nonexistent'), /Unknown index name/);
  });
});

describe('Search guards', () => {
  const db = openDb(tmpDbPath());
  createIndex(db, 'guards', [{ name: 'payload', type: 'TEXT' }]);
  db.transaction(() => {
    for (let i = 0; i < 300; i++) {
      addDocument(db, 'guards', `d${i}`, 1, false, { payload: `abc${i} common${i % 3 === 0 ? ' rare' : ''}` });
    }
  })();

  it('resolveSearchLimits applies defaults and rejects invalid values', () => {
    assert.deepEqual({ ...resolveSearchLimits() }, { minPrefix: 3, maxResults: 10000, timeoutMs: 500 });
    assert.deepEqual({ ...resolveSearchLimits({ minPrefix: 4, timeoutMs: 0 }) }, { minPrefix: 4, maxResults: 10000, timeoutMs: 0 });
    assert.throws(() => resolveSearchLimits({ minPrefix: 0 }), /minPrefix/);
    assert.throws(() => resolveSearchLimits({ maxResults: 1.5 }), /maxResults/);
    assert.throws(() => resolveSearchLimits({ timeoutMs: -1 }), /timeoutMs/);
  });

  it('rejects prefix terms shorter than minPrefix', () => {
    assert.throws(() => search(db, 'guards', 'a*'), /shorter than the minimum of 3 characters/);
    assert.throws(() => search(db, 'guards', 'ab*'), /minimum of 3/);
    assert.throws(() => search(db, 'guards', 'common ab*'), /minimum of 3/);
    assert.equal(search(db, 'guards', 'abc*', { count: 0 }).total, 300);
    assert.equal(search(db, 'guards', 'a*', { count: 0, limits: resolveSearchLimits({ minPrefix: 1 }) }).total, 300);
    assert.throws(
      () => search(db, 'guards', 'abc*', { limits: resolveSearchLimits({ minPrefix: 4 }) }),
      /minimum of 4/
    );
  });

  it('counts prefix length in characters, not bytes', () => {
    assert.throws(() => search(db, 'guards', 'éé*'), /minimum of 3/);
    assert.equal(search(db, 'guards', 'ééé*', { count: 0 }).total, 0);
  });

  it('stops counting at maxResults and ranks only what it read', () => {
    const limits = resolveSearchLimits({ maxResults: 50 });
    const capped = search(db, 'guards', 'abc*', { noContent: true, count: 10, limits });
    assert.equal(capped.total, 50);
    assert.equal(capped.docIds.length, 10);
    const beyond = search(db, 'guards', 'abc*', { noContent: true, offset: 45, count: 10, limits });
    assert.equal(beyond.docIds.length, 5);
    assert.equal(search(db, 'guards', 'rare', { count: 0 }).total, 100);
  });

  it('still ranks by bm25 when under the cap', () => {
    addDocument(db, 'guards', 'best', 1, false, { payload: 'rare rare rare' });
    const r = search(db, 'guards', 'rare', { noContent: true, count: 1 });
    assert.equal(r.total, 101);
    assert.deepEqual(r.docIds, ['best']);
    deleteDocument(db, 'guards', 'best');
  });

  it('aborts with a timeout error once the time budget is spent', () => {
    let t = 0;
    const clock = () => (t += 1);
    assert.throws(
      () => search(db, 'guards', 'abc*', { count: 0, timeoutMs: 3, clock }),
      (err) => err instanceof SearchTimeoutError && err.message === 'ERR Timeout limit was reached'
    );
  });

  it('uses the server default budget unless the query overrides it, and 0 disables it', () => {
    let t = 0;
    const clock = () => (t += 1000);
    const limits = resolveSearchLimits({ timeoutMs: 1 });
    assert.throws(() => search(db, 'guards', 'abc*', { count: 0, limits, clock }), SearchTimeoutError);
    assert.equal(search(db, 'guards', 'abc*', { count: 0, limits, clock, timeoutMs: 0 }).total, 300);
    assert.equal(search(db, 'guards', 'abc*', { count: 0, limits: resolveSearchLimits({ timeoutMs: 0 }), clock }).total, 300);
  });
});
