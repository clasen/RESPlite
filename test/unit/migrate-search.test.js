/**
 * Unit tests for migrate-search (SPEC_F §F.10).
 *
 * Uses a fake Redis client (no real Redis required) and real SQLite (tmpDbPath).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrateSearch, mapFields, buildDocFields, getDocScore } from '../../src/migration/migrate-search.js';
import { openDb } from '../../src/storage/sqlite/db.js';
import { getIndexMeta, getIndexCounts, search, suggestionGet } from '../../src/storage/sqlite/search.js';
import { tmpDbPath } from '../helpers/tmp.js';

// ── Fake Redis client builder ─────────────────────────────────────────────────

/**
 * Build a minimal fake Redis client for migrate-search tests.
 * Specify per-index data; everything else returns empty defaults.
 *
 * @param {object} opts
 * @param {string[]} [opts.indexNames]          FT._LIST response
 * @param {object}  [opts.indexInfo]            indexName → { keyType?, prefixes?, attributes[] }
 * @param {object}  [opts.hashKeys]             key → { field: value } (HGETALL responses)
 * @param {string[]} [opts.scanKeys]            Keys returned by SCAN
 * @param {object}  [opts.suggestions]          indexName → [[term, score], ...]
 */
function makeFakeRedis({
  indexNames = [],
  indexInfo  = {},
  hashKeys   = {},
  scanKeys   = [],
  suggestions = {},
} = {}) {
  return {
    async sendCommand(cmd) {
      const [command, ...args] = cmd.map(String);

      if (command === 'FT._LIST') {
        return indexNames;
      }

      if (command === 'FT.INFO') {
        const name = args[0];
        const info = indexInfo[name];
        if (!info) throw new Error(`ERR no such index`);
        const { keyType = 'HASH', prefixes = ['doc:'], attributes = [] } = info;
        // Return flat array format (same as older RediSearch / sendCommand)
        const attrsArray = attributes.map((a) => [
          'identifier', a.identifier ?? a.name,
          'attribute',  a.attribute  ?? a.name,
          'type',       a.type,
        ]);
        return [
          'index_name', name,
          'index_definition', [
            'key_type', keyType,
            'prefixes', prefixes,
          ],
          'attributes', attrsArray,
        ];
      }

      if (command === 'FT.SUGGET') {
        const name = args[0];
        const sugs = suggestions[name] ?? [];
        // Returns [term, score, term, score, ...]
        return sugs.flatMap(([term, score]) => [term, String(score)]);
      }

      return null;
    },

    async scan(cursor, { MATCH } = {}) {
      // Simple: return all keys on first call, cursor=0 to signal end
      if (cursor !== 0) return { cursor: 0, keys: [] };
      const pattern = MATCH ? MATCH.replace(/\*$/, '') : '';
      const matching = scanKeys.filter((k) => k.startsWith(pattern));
      return { cursor: 0, keys: matching };
    },

    async hGetAll(key) {
      return hashKeys[key] ?? {};
    },
  };
}

// ── mapFields ─────────────────────────────────────────────────────────────────

describe('mapFields', () => {
  it('maps TEXT fields directly', () => {
    const { fields, fieldMap, warnings } = mapFields([
      { identifier: 'title', attribute: 'title', type: 'TEXT' },
      { identifier: 'payload', attribute: 'payload', type: 'TEXT' },
    ]);
    assert.ok(fields.some((f) => f.name === 'title'));
    assert.ok(fields.some((f) => f.name === 'payload'));
    assert.equal(warnings.length, 0);
    assert.equal(fieldMap.get('title'), 'title');
    assert.equal(fieldMap.get('payload'), 'payload');
  });

  it('maps TAG and NUMERIC to TEXT with warnings', () => {
    const { fields, warnings } = mapFields([
      { identifier: 'tag_field', attribute: 'tag_field', type: 'TAG' },
      { identifier: 'num_field', attribute: 'num_field', type: 'NUMERIC' },
    ]);
    assert.ok(fields.some((f) => f.name === 'tag_field'));
    assert.ok(fields.some((f) => f.name === 'num_field'));
    assert.equal(warnings.filter((w) => w.includes('TAG')).length, 1);
    assert.equal(warnings.filter((w) => w.includes('NUMERIC')).length, 1);
  });

  it('skips GEO and VECTOR fields with warnings', () => {
    const { fields, warnings } = mapFields([
      { identifier: 'loc', attribute: 'loc', type: 'GEO' },
      { identifier: 'vec', attribute: 'vec', type: 'VECTOR' },
    ]);
    assert.equal(fields.filter((f) => f.name === 'loc' || f.name === 'vec').length, 0);
    assert.equal(warnings.filter((w) => w.includes('GEO')).length, 1);
    assert.equal(warnings.filter((w) => w.includes('VECTOR')).length, 1);
  });

  it('always ensures a payload field exists', () => {
    const { fields } = mapFields([
      { identifier: 'title', attribute: 'title', type: 'TEXT' },
    ]);
    assert.ok(fields.some((f) => f.name === 'payload'));
  });

  it('does not duplicate payload when already present', () => {
    const { fields } = mapFields([
      { identifier: 'payload', attribute: 'payload', type: 'TEXT' },
    ]);
    assert.equal(fields.filter((f) => f.name === 'payload').length, 1);
  });

  it('sanitises attribute names with special characters', () => {
    const { fields } = mapFields([
      { identifier: 'my field!', attribute: 'my field!', type: 'TEXT' },
    ]);
    const names = fields.map((f) => f.name);
    assert.ok(names.every((n) => /^[A-Za-z0-9:_-]+$/.test(n)), `invalid name in: ${names}`);
  });

  it('handles empty attributes array (adds only payload)', () => {
    const { fields, warnings } = mapFields([]);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].name, 'payload');
    assert.equal(warnings.length, 0);
  });
});

// ── buildDocFields ────────────────────────────────────────────────────────────

describe('buildDocFields', () => {
  it('maps hash data to schema fields', () => {
    const fieldMap = new Map([['title', 'title'], ['body', 'body'], ['payload', 'payload']]);
    const schemaFields = [
      { name: 'title' }, { name: 'body' }, { name: 'payload' },
    ];
    const result = buildDocFields({ title: 'Hello', body: 'World', payload: 'HP' }, fieldMap, schemaFields);
    assert.equal(result.title, 'Hello');
    assert.equal(result.body, 'World');
    assert.equal(result.payload, 'HP');
  });

  it('defaults missing hash fields to empty string', () => {
    const fieldMap = new Map([['title', 'title']]);
    const schemaFields = [{ name: 'title' }, { name: 'payload' }];
    const result = buildDocFields({}, fieldMap, schemaFields);
    assert.equal(result.title, '');
    assert.equal(result.payload, '');
  });

  it('synthesises payload from other fields when absent', () => {
    const fieldMap = new Map([['title', 'title'], ['body', 'body']]);
    const schemaFields = [{ name: 'title' }, { name: 'body' }, { name: 'payload' }];
    const result = buildDocFields({ title: 'Foo', body: 'Bar' }, fieldMap, schemaFields);
    assert.ok(result.payload.includes('Foo'));
    assert.ok(result.payload.includes('Bar'));
  });

  it('does not overwrite explicit payload with synthesised value', () => {
    const fieldMap = new Map([['payload', 'payload'], ['title', 'title']]);
    const schemaFields = [{ name: 'payload' }, { name: 'title' }];
    const result = buildDocFields({ payload: 'explicit', title: 'Other' }, fieldMap, schemaFields);
    assert.equal(result.payload, 'explicit');
  });
});

// ── getDocScore ───────────────────────────────────────────────────────────────

describe('getDocScore', () => {
  it('prefers __score over score', () => {
    assert.equal(getDocScore({ __score: '2.5', score: '1.0' }), 2.5);
  });

  it('uses score when __score is absent', () => {
    assert.equal(getDocScore({ score: '3.25' }), 3.25);
  });

  it('falls back to 1.0 for invalid score values', () => {
    assert.equal(getDocScore({ score: 'not-a-number' }), 1.0);
  });

  it('falls back to 1.0 when score fields are missing', () => {
    assert.equal(getDocScore({}), 1.0);
  });
});

// ── runMigrateSearch — core behaviour ─────────────────────────────────────────

describe('runMigrateSearch', () => {
  it('returns empty indices when FT._LIST returns []', async () => {
    const redis  = makeFakeRedis({ indexNames: [] });
    const result = await runMigrateSearch(redis, tmpDbPath());
    assert.deepEqual(result.indices, []);
    assert.equal(result.aborted, false);
  });

  it('skips index with invalid name', async () => {
    const redis = makeFakeRedis({ indexNames: ['1invalid-name'] });
    const result = await runMigrateSearch(redis, tmpDbPath());
    assert.equal(result.indices.length, 1);
    assert.ok(result.indices[0].error);
    assert.match(result.indices[0].error, /not valid in RespLite/);
  });

  it('skips non-HASH index type with error', async () => {
    const redis = makeFakeRedis({
      indexNames: ['jsonidx'],
      indexInfo:  { jsonidx: { keyType: 'JSON', prefixes: ['doc:'], attributes: [] } },
    });
    const result = await runMigrateSearch(redis, tmpDbPath());
    assert.equal(result.indices.length, 1);
    assert.ok(result.indices[0].error);
    assert.match(result.indices[0].error, /JSON/);
  });

  it('creates index and imports TEXT documents', async () => {
    const dbPath = tmpDbPath();
    const redis = makeFakeRedis({
      indexNames: ['products'],
      indexInfo:  {
        products: {
          prefixes: ['prod:'],
          attributes: [
            { identifier: 'name',    attribute: 'name',    type: 'TEXT' },
            { identifier: 'payload', attribute: 'payload', type: 'TEXT' },
          ],
        },
      },
      scanKeys: ['prod:1', 'prod:2'],
      hashKeys: {
        'prod:1': { name: 'Widget A', payload: 'A great widget' },
        'prod:2': { name: 'Widget B', payload: 'Another widget' },
      },
    });

    const result = await runMigrateSearch(redis, dbPath);
    assert.equal(result.indices.length, 1);
    const idx = result.indices[0];
    assert.equal(idx.name, 'products');
    assert.equal(idx.created, true);
    assert.equal(idx.docsImported, 2);
    assert.equal(idx.docErrors, 0);
    assert.equal(idx.error, undefined);

    // Verify index and docs exist in the DB
    const db = openDb(dbPath, { pragmaTemplate: 'minimal' });
    const meta = getIndexMeta(db, 'products');
    assert.ok(meta.schema.fields.some((f) => f.name === 'name'));
    const counts = getIndexCounts(db, 'products');
    assert.equal(counts.num_docs, 2);
    db.close();
  });

  it('maps TAG and NUMERIC fields to TEXT', async () => {
    const dbPath = tmpDbPath();
    const redis = makeFakeRedis({
      indexNames: ['mixed'],
      indexInfo:  {
        mixed: {
          prefixes: ['m:'],
          attributes: [
            { identifier: 'label',  attribute: 'label',  type: 'TAG' },
            { identifier: 'price',  attribute: 'price',  type: 'NUMERIC' },
            { identifier: 'payload',attribute: 'payload',type: 'TEXT' },
          ],
        },
      },
      scanKeys: ['m:1'],
      hashKeys: { 'm:1': { label: 'red', price: '9.99', payload: 'item' } },
    });

    const result = await runMigrateSearch(redis, dbPath);
    const idx = result.indices[0];
    assert.equal(idx.docsImported, 1);
    assert.equal(idx.warnings.filter((w) => w.includes('TAG')).length, 1);
    assert.equal(idx.warnings.filter((w) => w.includes('NUMERIC')).length, 1);

    const db = openDb(dbPath, { pragmaTemplate: 'minimal' });
    const meta = getIndexMeta(db, 'mixed');
    assert.ok(meta.schema.fields.every((f) => f.type === 'TEXT'));
    db.close();
  });

  it('synthesises payload when hash has no payload field', async () => {
    const dbPath = tmpDbPath();
    const redis = makeFakeRedis({
      indexNames: ['nopl'],
      indexInfo:  {
        nopl: {
          prefixes: ['np:'],
          attributes: [
            { identifier: 'title', attribute: 'title', type: 'TEXT' },
          ],
        },
      },
      scanKeys: ['np:1'],
      hashKeys: { 'np:1': { title: 'A document title' } },
    });

    const result = await runMigrateSearch(redis, dbPath);
    assert.equal(result.indices[0].docsImported, 1);

    const db = openDb(dbPath, { pragmaTemplate: 'minimal' });
    const r = search(db, 'nopl', 'document', { noContent: false });
    assert.equal(r.total, 1);
    db.close();
  });

  it('skips empty hash keys (docsSkipped++)', async () => {
    const redis = makeFakeRedis({
      indexNames: ['empties'],
      indexInfo:  { empties: { prefixes: ['e:'], attributes: [] } },
      scanKeys: ['e:1', 'e:2'],
      hashKeys: {
        'e:1': {},    // empty → skipped
        'e:2': null,  // null  → skipped
      },
    });
    const result = await runMigrateSearch(redis, tmpDbPath());
    const idx = result.indices[0];
    assert.equal(idx.docsImported, 0);
    assert.equal(idx.docsSkipped, 2);
  });

  it('skipExisting=true reuses an existing index and refreshes documents', async () => {
    const dbPath = tmpDbPath();
    // First run — creates index
    const redis = makeFakeRedis({
      indexNames: ['myidx'],
      indexInfo:  { myidx: { prefixes: ['x:'], attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }] } },
      scanKeys: ['x:1'],
      hashKeys: { 'x:1': { payload: 'hello' } },
    });
    await runMigrateSearch(redis, dbPath, { skipExisting: true });

    // Second run — should skip
    const result2 = await runMigrateSearch(redis, dbPath, { skipExisting: true });
    assert.equal(result2.indices[0].skipped, true);
    assert.equal(result2.indices[0].created, false);
    assert.equal(result2.indices[0].error, undefined);
    assert.equal(result2.indices[0].docsImported, 1);
    assert.ok(result2.indices[0].warnings.some((w) => w.includes('reusing existing schema')));
  });

  it('skipExisting=false errors on existing index', async () => {
    const dbPath = tmpDbPath();
    const redis = makeFakeRedis({
      indexNames: ['dup'],
      indexInfo:  { dup: { prefixes: ['d:'], attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }] } },
      scanKeys: [],
      hashKeys: {},
    });
    await runMigrateSearch(redis, dbPath);
    const result2 = await runMigrateSearch(redis, dbPath, { skipExisting: false });
    assert.ok(result2.indices[0].error);
    assert.match(result2.indices[0].error, /already exists/);
  });

  it('onlyIndices filters which indices are migrated', async () => {
    const redis = makeFakeRedis({
      indexNames: ['a', 'b', 'c'],
      indexInfo:  {
        a: { prefixes: ['a:'], attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }] },
        b: { prefixes: ['b:'], attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }] },
        c: { prefixes: ['c:'], attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }] },
      },
      scanKeys: [],
      hashKeys: {},
    });
    const result = await runMigrateSearch(redis, tmpDbPath(), { onlyIndices: ['a', 'c'] });
    const names = result.indices.map((i) => i.name);
    assert.deepEqual(names, ['a', 'c']);
  });

  it('deduplicates keys that match overlapping index prefixes', async () => {
    const dbPath = tmpDbPath();
    const redis = makeFakeRedis({
      indexNames: ['overlap'],
      indexInfo: {
        overlap: {
          prefixes: ['doc:', 'doc:special:'],
          attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }],
        },
      },
      scanKeys: ['doc:special:1'],
      hashKeys: {
        'doc:special:1': { payload: 'hello overlap' },
      },
    });

    const result = await runMigrateSearch(redis, dbPath);
    assert.equal(result.indices.length, 1);
    assert.equal(result.indices[0].docsImported, 1);

    const db = openDb(dbPath, { pragmaTemplate: 'minimal' });
    const counts = getIndexCounts(db, 'overlap');
    assert.equal(counts.num_docs, 1);
    db.close();
  });

  it('imports suggestions', async () => {
    const dbPath = tmpDbPath();
    const redis = makeFakeRedis({
      indexNames: ['sug_test'],
      indexInfo:  {
        sug_test: {
          prefixes: ['s:'],
          attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }],
        },
      },
      scanKeys: [],
      hashKeys: {},
      suggestions: {
        sug_test: [['apple', 10], ['apply', 5], ['banana', 1]],
      },
    });

    const result = await runMigrateSearch(redis, dbPath, { withSuggestions: true });
    assert.equal(result.indices[0].sugsImported, 3);

    const db = openDb(dbPath, { pragmaTemplate: 'minimal' });
    const sugs = suggestionGet(db, 'sug_test', 'app', { max: 10 });
    assert.ok(sugs.length >= 2);
    assert.ok(sugs.includes('apple'));
    assert.ok(sugs.includes('apply'));
    db.close();
  });

  it('withSuggestions=false skips suggestion import', async () => {
    const dbPath = tmpDbPath();
    const redis = makeFakeRedis({
      indexNames: ['nosug'],
      indexInfo:  { nosug: { prefixes: ['n:'], attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }] } },
      suggestions: { nosug: [['term', 1]] },
      scanKeys: [],
      hashKeys: {},
    });
    const result = await runMigrateSearch(redis, dbPath, { withSuggestions: false });
    assert.equal(result.indices[0].sugsImported, 0);
  });

  it('handles FT.INFO failure gracefully', async () => {
    const redis = makeFakeRedis({
      indexNames: ['ghost'],
      indexInfo:  {}, // FT.INFO will throw because no entry
    });
    const result = await runMigrateSearch(redis, tmpDbPath());
    assert.equal(result.indices.length, 1);
    assert.ok(result.indices[0].error);
    assert.match(result.indices[0].error, /FT\.INFO failed/);
  });

  it('handles SCAN with empty prefix (no prefix restriction)', async () => {
    const dbPath = tmpDbPath();
    const redis = makeFakeRedis({
      indexNames: ['allkeys'],
      indexInfo:  {
        allkeys: {
          prefixes: [''],  // empty prefix → match all keys
          attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }],
        },
      },
      scanKeys: ['doc:1', 'other:2'],
      hashKeys: {
        'doc:1':   { payload: 'first document' },
        'other:2': { payload: 'second document' },
      },
    });
    const result = await runMigrateSearch(redis, dbPath);
    assert.equal(result.indices[0].docsImported, 2);
  });

  it('reads document score from __score field', async () => {
    const dbPath = tmpDbPath();
    const redis = makeFakeRedis({
      indexNames: ['scored'],
      indexInfo:  {
        scored: {
          prefixes: ['s:'],
          attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }],
        },
      },
      scanKeys: ['s:1'],
      hashKeys: { 's:1': { payload: 'important', __score: '2.5' } },
    });
    const result = await runMigrateSearch(redis, dbPath);
    assert.equal(result.indices[0].docsImported, 1);
    // Verify doc exists and is searchable
    const db = openDb(dbPath, { pragmaTemplate: 'minimal' });
    const r = search(db, 'scored', 'important', { noContent: true });
    assert.equal(r.total, 1);
    db.close();
  });

  it('onProgress is called for each index', async () => {
    const calls = [];
    const redis = makeFakeRedis({
      indexNames: ['idx1', 'idx2'],
      indexInfo:  {
        idx1: { prefixes: ['i1:'], attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }] },
        idx2: { prefixes: ['i2:'], attributes: [{ identifier: 'payload', attribute: 'payload', type: 'TEXT' }] },
      },
      scanKeys: [],
      hashKeys: {},
    });
    await runMigrateSearch(redis, tmpDbPath(), { onProgress: (r) => calls.push(r.name) });
    assert.deepEqual(calls, ['idx1', 'idx2']);
  });

  it('does not call onProgress for error/skip before index processing', async () => {
    const calls = [];
    const redis = makeFakeRedis({
      indexNames: ['1bad'],  // invalid name — errored before processing
    });
    await runMigrateSearch(redis, tmpDbPath(), {
      onProgress: (r) => calls.push(r.name),
    });
    // Error results are pushed to results[] but onProgress is NOT called for them
    assert.equal(calls.length, 0);
  });
});
