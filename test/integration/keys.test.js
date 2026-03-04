import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

describe('KEYS integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('KEYS * returns matching keys', async () => {
    await sendCommand(port, argv('SET', 'keys:k1', 'v1'));
    await sendCommand(port, argv('SET', 'keys:k2', 'v2'));
    await sendCommand(port, argv('SET', 'other:k3', 'v3'));

    const reply = await sendCommand(port, argv('KEYS', 'keys:*'));
    const parsed = tryParseValue(reply, 0);
    assert.ok(Array.isArray(parsed.value));
    const values = parsed.value.map((v) => v.toString('utf8')).sort();
    assert.deepEqual(values, ['keys:k1', 'keys:k2']);
  });

  it('KEYS with ? wildcard works', async () => {
    await sendCommand(port, argv('SET', 'q:a1', 'x'));
    await sendCommand(port, argv('SET', 'q:b2', 'x'));
    await sendCommand(port, argv('SET', 'q:bb2', 'x'));

    const reply = await sendCommand(port, argv('KEYS', 'q:?2'));
    const parsed = tryParseValue(reply, 0);
    const values = parsed.value.map((v) => v.toString('utf8')).sort();
    assert.deepEqual(values, ['q:b2']);
  });

  it('KEYS wrong number of arguments returns error', async () => {
    const reply = await sendCommand(port, argv('KEYS'));
    const parsed = tryParseValue(reply, 0);
    assert.ok(parsed.value && parsed.value.error);
    assert.ok(parsed.value.error.includes('wrong number of arguments'));
  });
});
