import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

describe('Concurrency stress', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('many INCR on same key', async () => {
    await sendCommand(port, argv('SET', 'n', '0'));
    const N = 50;
    const promises = Array.from({ length: N }, () => sendCommand(port, argv('INCR', 'n')));
    await Promise.all(promises);
    const final = await sendCommand(port, argv('GET', 'n'));
    const parsed = tryParseValue(final, 0);
    const val = parseInt(parsed.value.toString('ascii'), 10);
    assert.equal(val, N);
  });
});
