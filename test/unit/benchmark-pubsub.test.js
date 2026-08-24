import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScenarios,
  createPayload,
  parseArgs,
  summarizeLatencies,
} from '../../scripts/benchmark-pubsub.js';

describe('Pub/Sub benchmark configuration', () => {
  it('parses explicit benchmark options', () => {
    const options = parseArgs([
      '--iterations', '25',
      '--warmup', '2',
      '--subscribers', '0,2,2',
      '--message-sizes', '64,1024',
      '--redis-port', '6381',
      '--resplite-port', '6382',
      '--template', 'performance',
      '--timeout-ms', '5000',
      '--resplite-only',
    ]);

    assert.equal(options.iterations, 25);
    assert.equal(options.warmup, 2);
    assert.deepEqual(options.subscribers, [0, 2]);
    assert.deepEqual(options.messageSizes, [64, 1024]);
    assert.equal(options.redisPort, 6381);
    assert.equal(options.resplitePort, 6382);
    assert.equal(options.template, 'performance');
    assert.equal(options.timeoutMs, 5000);
    assert.equal(options.respliteOnly, true);
  });

  it('rejects invalid and unknown options', () => {
    assert.throws(() => parseArgs(['--iterations', '0']), /at least 1/);
    assert.throws(() => parseArgs(['--subscribers', '1,-1']), /must be an integer/);
    assert.throws(() => parseArgs(['--message-sizes', '11']), /at least 12/);
    assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  });

  it('builds one baseline and direct/pattern fan-out scenarios', () => {
    assert.deepEqual(buildScenarios([0, 2], [64]), [
      { id: 'direct:0:64', mode: 'direct', subscribers: 0, messageBytes: 64 },
      { id: 'direct:2:64', mode: 'direct', subscribers: 2, messageBytes: 64 },
      { id: 'pattern:2:64', mode: 'pattern', subscribers: 2, messageBytes: 64 },
    ]);
  });

  it('creates exact-size payloads and calculates nearest-rank percentiles', () => {
    const payload = createPayload('m', 42, 64);
    assert.equal(Buffer.byteLength(payload), 64);
    assert.equal(payload.slice(0, 12), 'm0000000042:');
    assert.deepEqual(summarizeLatencies([1, 2, 3, 4, 100]), {
      p50: 3,
      p95: 100,
      p99: 100,
    });
  });
});
