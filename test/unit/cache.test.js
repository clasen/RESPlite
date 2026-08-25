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

  it('clear removes all entries while preserving access counters', () => {
    const cache = createCache({ enabled: true });
    cache.set('a', 'string', Buffer.from('one'), 1, null);
    cache.set('b', 'string', Buffer.from('two'), 1, null);
    cache.get('a');
    cache.get('missing');

    cache.clear();

    assert.deepEqual(cache.stats, {
      enabled: true,
      entries: 0,
      bytes: 0,
      hits: 1,
      misses: 1,
      hitRatio: 0.5,
    });
  });

  it('exposes per-type collection limits', () => {
    const cache = createCache({
      maxSetMembers: 10,
      maxSetBytes: 11,
      maxListItems: 12,
      maxListBytes: 13,
      maxZsetMembers: 14,
      maxZsetBytes: 15,
    });
    assert.deepEqual(
      {
        maxSetMembers: cache.limits.maxSetMembers,
        maxSetBytes: cache.limits.maxSetBytes,
        maxListItems: cache.limits.maxListItems,
        maxListBytes: cache.limits.maxListBytes,
        maxZsetMembers: cache.limits.maxZsetMembers,
        maxZsetBytes: cache.limits.maxZsetBytes,
      },
      {
        maxSetMembers: 10,
        maxSetBytes: 11,
        maxListItems: 12,
        maxListBytes: 13,
        maxZsetMembers: 14,
        maxZsetBytes: 15,
      }
    );
  });

  it('promotes hits and evicts the least recently used entry', () => {
    const lru = createLRU({ maxEntries: 2 });
    lru.set('a', { value: Buffer.from('a') });
    lru.set('b', { value: Buffer.from('b') });

    assert.ok(lru.get('a')); // a is now newer than b
    lru.set('c', { value: Buffer.from('c') });

    assert.equal(lru.get('b'), null);
    assert.equal(lru.get('a').value.toString(), 'a');
    assert.equal(lru.get('c').value.toString(), 'c');
  });

  it('evicts by byte budget and reports the retained bytes', () => {
    const lru = createLRU({ maxEntries: 10, maxBytes: 5 });
    lru.set('a', { value: Buffer.from('123') });
    lru.set('b', { value: Buffer.from('456') });

    assert.equal(lru.get('a'), null);
    assert.equal(lru.get('b').value.toString(), '456');
    assert.deepEqual(
      { entries: lru.stats.entries, bytes: lru.stats.bytes },
      { entries: 1, bytes: 3 }
    );
  });

  it('replaces a full-cache entry without evicting another key', () => {
    const lru = createLRU({ maxEntries: 2, maxBytes: 10 });
    lru.set('a', { value: Buffer.from('aa') });
    lru.set('b', { value: Buffer.from('bb') });
    lru.set('a', { value: Buffer.from('AAA') });

    assert.equal(lru.stats.entries, 2);
    assert.equal(lru.stats.bytes, 5);
    assert.equal(lru.get('a').value.toString(), 'AAA');
    assert.equal(lru.get('b').value.toString(), 'bb');
  });

  it('does not cache an oversized value or evict unrelated hot entries', () => {
    const lru = createLRU({ maxEntries: 10, maxBytes: 4 });
    lru.set('hot', { value: Buffer.from('1234') });
    lru.set('oversized', { value: Buffer.from('12345') });

    assert.equal(lru.stats.entries, 1);
    assert.equal(lru.stats.bytes, 4);
    assert.equal(lru.get('oversized'), null);
    assert.equal(lru.get('hot').value.toString(), '1234');

    // Replacing an existing key with an oversized value must remove the stale
    // cached representation of that key.
    lru.set('hot', { value: Buffer.from('12345') });
    assert.equal(lru.stats.entries, 0);
    assert.equal(lru.stats.bytes, 0);
  });

  it('keeps disabled cache statistics at zero', () => {
    const cache = createCache({ enabled: false });
    cache.set('k', 'string', Buffer.from('value'), 1, null);
    assert.equal(cache.get('k'), null);
    cache.invalidate('k');
    cache.clear();

    assert.deepEqual(cache.stats, {
      enabled: false,
      entries: 0,
      bytes: 0,
      hits: 0,
      misses: 0,
      hitRatio: 0,
    });
  });
});
