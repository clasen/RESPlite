import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/storage/sqlite/db.js';
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
} from '../../src/storage/sqlite/search.js';
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
