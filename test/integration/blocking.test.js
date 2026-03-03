/**
 * Integration tests for blocking list commands (BLPOP, BRPOP) — SPEC_E.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Blocking lists (BLPOP/BRPOP)', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('BLPOP returns immediately when key has element', async () => {
    await sendCommand(port, argv('RPUSH', 'bq1', 'a'));
    const reply = await sendCommand(port, argv('BLPOP', 'bq1', '1'));
    const parsed = tryParseValue(reply, 0);
    assert.ok(Array.isArray(parsed.value));
    assert.equal(parsed.value.length, 2);
    assert.equal(parsed.value[0].toString('utf8'), 'bq1');
    assert.equal(parsed.value[1].toString('utf8'), 'a');
  });

  it('BRPOP returns immediately when key has element', async () => {
    await sendCommand(port, argv('RPUSH', 'bq2', 'x'));
    const reply = await sendCommand(port, argv('BRPOP', 'bq2', '1'));
    const parsed = tryParseValue(reply, 0);
    assert.ok(Array.isArray(parsed.value));
    assert.equal(parsed.value[0].toString('utf8'), 'bq2');
    assert.equal(parsed.value[1].toString('utf8'), 'x');
  });

  it('BLPOP blocks then returns after RPUSH from another client', async () => {
    const blockPromise = sendCommand(port, argv('BLPOP', 'bq3', '5'));
    await delay(80);
    await sendCommand(port, argv('RPUSH', 'bq3', 'woken'));
    const reply = await blockPromise;
    const parsed = tryParseValue(reply, 0);
    assert.ok(Array.isArray(parsed.value));
    assert.equal(parsed.value[0].toString('utf8'), 'bq3');
    assert.equal(parsed.value[1].toString('utf8'), 'woken');
  });

  it('BRPOP blocks then returns after LPUSH from another client', async () => {
    const blockPromise = sendCommand(port, argv('BRPOP', 'bq4', '5'));
    await delay(80);
    await sendCommand(port, argv('LPUSH', 'bq4', 'tail'));
    const reply = await blockPromise;
    const parsed = tryParseValue(reply, 0);
    assert.ok(Array.isArray(parsed.value));
    assert.equal(parsed.value[0].toString('utf8'), 'bq4');
    assert.equal(parsed.value[1].toString('utf8'), 'tail');
  });

  it('BLPOP with timeout returns nil after timeout', async () => {
    const reply = await sendCommand(port, argv('BLPOP', 'emptyq', '1'));
    const parsed = tryParseValue(reply, 0);
    assert.strictEqual(parsed.value, null);
  });

  it('BLPOP wrong number of arguments returns error', async () => {
    const reply = await sendCommand(port, argv('BLPOP', 'k'));
    const parsed = tryParseValue(reply, 0);
    assert.ok(parsed.value && parsed.value.error);
    assert.ok(parsed.value.error.includes('wrong number of arguments'));
  });

  it('BLPOP invalid timeout returns error', async () => {
    const reply = await sendCommand(port, argv('BLPOP', 'k', 'x'));
    const parsed = tryParseValue(reply, 0);
    assert.ok(parsed.value && parsed.value.error);
    assert.ok(parsed.value.error.includes('timeout'));
  });

  it('BLPOP on wrong type key returns WRONGTYPE', async () => {
    await sendCommand(port, argv('SET', 'strkey', 'v'));
    const reply = await sendCommand(port, argv('BLPOP', 'strkey', '0'));
    const parsed = tryParseValue(reply, 0);
    assert.ok(parsed.value && parsed.value.error);
    assert.ok(parsed.value.error.includes('WRONGTYPE'));
  });

  it('BLPOP multi-key returns first available in key order', async () => {
    const blockPromise = sendCommand(port, argv('BLPOP', 'k1', 'k2', '5'));
    await delay(50);
    await sendCommand(port, argv('RPUSH', 'k2', 'second'));
    const reply = await blockPromise;
    const parsed = tryParseValue(reply, 0);
    assert.ok(Array.isArray(parsed.value));
    assert.equal(parsed.value[0].toString('utf8'), 'k2');
    assert.equal(parsed.value[1].toString('utf8'), 'second');
  });
});
