import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importKeyFromRedis } from '../../src/migration/import-one.js';

function makeStorages() {
  const calls = {
    zsetAdds: [],
    setExpires: [],
  };
  return {
    calls,
    storages: {
      keys: {
        setExpires(key, expiresAt, updatedAt) {
          calls.setExpires.push({ key, expiresAt, updatedAt });
        },
      },
      strings: {},
      hashes: {},
      sets: {},
      lists: {},
      zsets: {
        add(key, pairs) {
          calls.zsetAdds.push({ key, pairs });
        },
      },
    },
  };
}

describe('importKeyFromRedis zset handling', () => {
  it('imports large zsets with ZSCAN chunks', async () => {
    const { storages, calls } = makeStorages();
    let scanCalls = 0;
    const redis = {
      async type() {
        return 'zset';
      },
      async pTTL() {
        return -1;
      },
      async sendCommand(argv) {
        assert.equal(argv[0], 'ZSCAN');
        scanCalls += 1;
        if (scanCalls === 1) return ['7', ['a', '1', 'b', '2']];
        if (scanCalls === 2) return ['0', ['c', '3']];
        return ['0', []];
      },
      async zRangeWithScores() {
        throw new Error('fallback should not be used when ZSCAN works');
      },
    };

    const result = await importKeyFromRedis(redis, 'big:zset', storages, { now: 1000, zsetScanCount: 2 });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, undefined);
    assert.equal(scanCalls, 2);
    assert.equal(calls.zsetAdds.length, 2);
    assert.equal(calls.zsetAdds[0].pairs.length, 2);
    assert.equal(calls.zsetAdds[1].pairs.length, 1);
    assert.equal(calls.setExpires.length, 1);
    // key bytes + member bytes + score metadata estimate (8 bytes/member)
    assert.equal(result.bytes, Buffer.byteLength('big:zset') + (1 + 1 + 1) + (3 * 8));
  });

  it('falls back to zRangeWithScores when ZSCAN passthrough is unavailable', async () => {
    const { storages, calls } = makeStorages();
    let fallbackUsed = false;
    const redis = {
      async type() {
        return 'zset';
      },
      async pTTL() {
        return -1;
      },
      async sendCommand() {
        throw new Error('sendCommand not supported');
      },
      async zRangeWithScores() {
        fallbackUsed = true;
        return [{ value: 'member-1', score: 42 }];
      },
    };

    const result = await importKeyFromRedis(redis, 'legacy:zset', storages, { now: 1000 });

    assert.equal(result.ok, true);
    assert.equal(fallbackUsed, true);
    assert.equal(calls.zsetAdds.length, 1);
    assert.equal(calls.zsetAdds[0].pairs.length, 1);
    assert.equal(calls.setExpires.length, 1);
  });
});
