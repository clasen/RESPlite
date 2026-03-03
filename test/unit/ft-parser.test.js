import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFtCreate,
  parseFtInfo,
  parseFtAdd,
  parseFtDel,
  parseFtSearch,
  parseFtSugadd,
  parseFtSugget,
  parseFtSugdel,
} from '../../src/commands/ft/parser.js';

function buf(s) {
  return Buffer.from(s, 'utf8');
}

describe('FT parser', () => {
  describe('parseFtCreate', () => {
    it('accepts valid FT.CREATE', () => {
      const r = parseFtCreate([buf('names'), buf('SCHEMA'), buf('payload'), buf('TEXT')]);
      assert.ok(!r.error);
      assert.equal(r.indexName, 'names');
      assert.deepEqual(r.fields, [{ name: 'payload', type: 'TEXT' }]);
    });

    it('accepts multiple fields', () => {
      const r = parseFtCreate([buf('idx'), buf('SCHEMA'), buf('payload'), buf('TEXT'), buf('title'), buf('TEXT')]);
      assert.ok(!r.error);
      assert.equal(r.fields.length, 2);
    });

    it('rejects missing SCHEMA', () => {
      const r = parseFtCreate([buf('names'), buf('payload'), buf('TEXT')]);
      assert.equal(r.error, 'ERR syntax error');
    });

    it('rejects missing payload field', () => {
      const r = parseFtCreate([buf('idx'), buf('SCHEMA'), buf('title'), buf('TEXT')]);
      assert.equal(r.error, 'ERR payload field required');
    });

    it('rejects unsupported field type', () => {
      const r = parseFtCreate([buf('idx'), buf('SCHEMA'), buf('payload'), buf('NUMERIC')]);
      assert.equal(r.error, 'ERR unsupported field type');
    });

    it('rejects invalid index name', () => {
      const r = parseFtCreate([buf('1idx'), buf('SCHEMA'), buf('payload'), buf('TEXT')]);
      assert.equal(r.error, 'ERR invalid index name');
    });

    it('rejects odd number of field tokens', () => {
      const r = parseFtCreate([buf('idx'), buf('SCHEMA'), buf('payload')]);
      assert.equal(r.error, 'ERR syntax error');
    });
  });

  describe('parseFtInfo', () => {
    it('accepts single index name', () => {
      const r = parseFtInfo([buf('names')]);
      assert.ok(!r.error);
      assert.equal(r.indexName, 'names');
    });

    it('rejects wrong number of args', () => {
      assert.equal(parseFtInfo([]).error, 'ERR syntax error');
      assert.equal(parseFtInfo([buf('a'), buf('b')]).error, 'ERR syntax error');
    });
  });

  describe('parseFtAdd', () => {
    it('accepts valid FT.ADD', () => {
      const r = parseFtAdd([buf('names'), buf('doc1'), buf('1'), buf('REPLACE'), buf('FIELDS'), buf('payload'), buf('hello')]);
      assert.ok(!r.error);
      assert.equal(r.indexName, 'names');
      assert.equal(r.docId, 'doc1');
      assert.equal(r.score, 1);
      assert.equal(r.replace, true);
      assert.deepEqual(r.fields, { payload: 'hello' });
    });

    it('accepts without REPLACE', () => {
      const r = parseFtAdd([buf('n'), buf('d'), buf('2.5'), buf('FIELDS'), buf('payload'), buf('x')]);
      assert.ok(!r.error);
      assert.equal(r.replace, false);
      assert.equal(r.score, 2.5);
    });

    it('rejects missing FIELDS', () => {
      const r = parseFtAdd([buf('n'), buf('d'), buf('1')]);
      assert.equal(r.error, 'ERR syntax error');
    });

    it('rejects invalid score', () => {
      const r = parseFtAdd([buf('n'), buf('d'), buf('abc'), buf('FIELDS'), buf('payload'), buf('x')]);
      assert.equal(r.error, 'ERR invalid score');
    });

    it('rejects odd field pairs', () => {
      const r = parseFtAdd([buf('n'), buf('d'), buf('1'), buf('FIELDS'), buf('payload')]);
      assert.equal(r.error, 'ERR syntax error');
    });
  });

  describe('parseFtDel', () => {
    it('accepts index and doc_id', () => {
      const r = parseFtDel([buf('names'), buf('doc1')]);
      assert.ok(!r.error);
      assert.equal(r.indexName, 'names');
      assert.equal(r.docId, 'doc1');
    });

    it('rejects wrong number of args', () => {
      assert.equal(parseFtDel([buf('a')]).error, 'ERR syntax error');
      assert.equal(parseFtDel([buf('a'), buf('b'), buf('c')]).error, 'ERR syntax error');
    });
  });

  describe('parseFtSearch', () => {
    it('accepts index and query', () => {
      const r = parseFtSearch([buf('names'), buf('hello')]);
      assert.ok(!r.error);
      assert.equal(r.indexName, 'names');
      assert.equal(r.query, 'hello');
      assert.equal(r.noContent, false);
      assert.equal(r.offset, 0);
      assert.equal(r.count, 10);
    });

    it('accepts NOCONTENT and LIMIT', () => {
      const r = parseFtSearch([buf('n'), buf('q'), buf('NOCONTENT'), buf('LIMIT'), buf('5'), buf('25')]);
      assert.ok(!r.error);
      assert.equal(r.noContent, true);
      assert.equal(r.offset, 5);
      assert.equal(r.count, 25);
    });

    it('rejects invalid LIMIT', () => {
      const r = parseFtSearch([buf('n'), buf('q'), buf('LIMIT'), buf('-1'), buf('10')]);
      assert.equal(r.error, 'ERR invalid limit');
    });
  });

  describe('parseFtSugadd', () => {
    it('accepts index term score', () => {
      const r = parseFtSugadd([buf('names'), buf('term1'), buf('1.0')]);
      assert.ok(!r.error);
      assert.equal(r.indexName, 'names');
      assert.equal(r.term, 'term1');
      assert.equal(r.score, 1);
      assert.equal(r.incr, false);
    });

    it('accepts INCR and PAYLOAD', () => {
      const r = parseFtSugadd([buf('n'), buf('t'), buf('5'), buf('INCR'), buf('PAYLOAD'), buf('pdata')]);
      assert.ok(!r.error);
      assert.equal(r.incr, true);
      assert.equal(r.payload, 'pdata');
    });

    it('rejects invalid score', () => {
      const r = parseFtSugadd([buf('n'), buf('t'), buf('x')]);
      assert.equal(r.error, 'ERR invalid score');
    });
  });

  describe('parseFtSugget', () => {
    it('accepts index and prefix', () => {
      const r = parseFtSugget([buf('names'), buf('app')]);
      assert.ok(!r.error);
      assert.equal(r.prefix, 'app');
      assert.equal(r.max, 5);
    });

    it('accepts MAX WITHSCORES WITHPAYLOADS', () => {
      const r = parseFtSugget([buf('n'), buf('p'), buf('MAX'), buf('10'), buf('WITHSCORES'), buf('WITHPAYLOADS')]);
      assert.ok(!r.error);
      assert.equal(r.max, 10);
      assert.equal(r.withScores, true);
      assert.equal(r.withPayloads, true);
    });

    it('rejects FUZZY with not supported yet', () => {
      const r = parseFtSugget([buf('n'), buf('p'), buf('FUZZY')]);
      assert.equal(r.error, 'ERR not supported yet');
    });
  });

  describe('parseFtSugdel', () => {
    it('accepts index and term', () => {
      const r = parseFtSugdel([buf('names'), buf('term1')]);
      assert.ok(!r.error);
      assert.equal(r.indexName, 'names');
      assert.equal(r.term, 'term1');
    });

    it('rejects wrong number of args', () => {
      assert.equal(parseFtSugdel([buf('a')]).error, 'ERR syntax error');
    });
  });
});
