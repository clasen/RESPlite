import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLRU } from '../../src/cache/lru.js';
import { createCache } from '../../src/cache/cache.js';

describe('Cache', () => {
  it('LRU get/set and eviction', () => {
    const lru = createLRU({ maxEntries: 2 });
    lru.set('a', { kind: 'string', version: 1, expiresAt: null, value: Buffer.from('x') });
    const ent = lru.get('a');
    assert.ok(ent);
    assert.equal(ent.value.toString(), 'x');
    lru.set('b', { kind: 'string', version: 1, expiresAt: null, value: Buffer.from('y') });
    lru.set('c', { kind: 'string', version: 1, expiresAt: null, value: Buffer.from('z') });
    assert.equal(lru.get('a'), null);
    assert.ok(lru.get('b'));
    assert.ok(lru.get('c'));
  });

  it('cache stats', () => {
    const cache = createCache({ enabled: true });
    cache.set('k', 'string', Buffer.from('v'), 1, null);
    assert.equal(cache.stats.entries, 1);
    cache.get('k');
    assert.equal(cache.stats.hits, 1);
    cache.get('missing');
    assert.equal(cache.stats.misses, 1);
  });
});
