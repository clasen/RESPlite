import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchPattern } from '../../src/util/patterns.js';

describe('Redis glob matching', () => {
  it('supports wildcards, ranges, negated classes and escaping', () => {
    assert.equal(matchPattern('user:42', 'user:*'), true);
    assert.equal(matchPattern('user:a', 'user:[a-c]'), true);
    assert.equal(matchPattern('user:z', 'user:[^a-c]'), true);
    assert.equal(matchPattern('literal*', 'literal\\*'), true);
    assert.equal(matchPattern('user:long', 'user:?'), false);
  });

  it('matches binary values without UTF-8 conversion', () => {
    assert.equal(matchPattern(Buffer.from([0, 255, 2]), Buffer.from([0, 63, 2])), true);
    assert.equal(matchPattern(Buffer.from([0, 255, 2]), Buffer.from([0, 254, 2])), false);
  });
});
