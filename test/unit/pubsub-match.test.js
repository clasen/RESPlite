import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchPubSubPattern } from '../../src/pubsub/match.js';

function matches(pattern, value) {
  return matchPubSubPattern(Buffer.from(pattern), Buffer.from(value));
}

describe('Pub/Sub glob matching', () => {
  it('supports wildcards and escaped metacharacters', () => {
    assert.equal(matches('news:*', 'news:sports'), true);
    assert.equal(matches('news:?', 'news:a'), true);
    assert.equal(matches('news:?', 'news:ab'), false);
    assert.equal(matches('literal\\*', 'literal*'), true);
    assert.equal(matches('literal\\*', 'literal-anything'), false);
  });

  it('supports character classes, ranges and negation', () => {
    assert.equal(matches('room:[abc]', 'room:b'), true);
    assert.equal(matches('room:[a-c]', 'room:c'), true);
    assert.equal(matches('room:[c-a]', 'room:b'), true);
    assert.equal(matches('room:[^a-c]', 'room:z'), true);
    assert.equal(matches('room:[^a-c]', 'room:b'), false);
  });

  it('matches arbitrary bytes without UTF-8 conversion', () => {
    const pattern = Buffer.from([0x00, 0x3f, 0xff]);
    const value = Buffer.from([0x00, 0x80, 0xff]);
    assert.equal(matchPubSubPattern(pattern, value), true);
  });

  it('rejects incomplete character classes', () => {
    assert.equal(matches('room:[abc', 'room:a'), false);
  });
});
