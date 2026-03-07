/**
 * Integration tests for COMMAND (introspection).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

describe('COMMAND integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('COMMAND (no args) returns array of command docs', async () => {
    const reply = await sendCommand(port, argv('COMMAND'));
    const v = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(v), 'expected array');
    assert.ok(v.length > 0, 'expected at least one command');
    const pingDoc = v.find((doc) => {
      const n = Buffer.isBuffer(doc[0]) ? doc[0].toString('utf8') : doc[0];
      return n === 'ping';
    });
    assert.ok(pingDoc, 'expected ping in command list');
    const first = pingDoc;
    assert.ok(Array.isArray(first), 'each doc is array');
    const name = Buffer.isBuffer(first[0]) ? first[0].toString('utf8') : first[0];
    assert.strictEqual(name, 'ping', 'first element is name (lowercase)');
    assert.strictEqual(typeof first[1], 'number', 'arity');
    assert.ok(Array.isArray(first[2]), 'flags');
    const flags = first[2].map((f) => (Buffer.isBuffer(f) ? f.toString('utf8') : f));
    assert.ok(flags.includes('readonly') || flags.includes('write'));
  });

  it('COMMAND COUNT returns integer', async () => {
    const reply = await sendCommand(port, argv('COMMAND', 'COUNT'));
    const v = tryParseValue(reply, 0).value;
    assert.strictEqual(typeof v, 'number');
    assert.ok(Number.isInteger(v) && v > 0);
  });

  it('COMMAND INFO name returns doc for that command', async () => {
    const reply = await sendCommand(port, argv('COMMAND', 'INFO', 'GET'));
    const v = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(v));
    assert.ok(v.length >= 1);
    const getDoc = v[0];
    const name = Buffer.isBuffer(getDoc[0]) ? getDoc[0].toString('utf8') : getDoc[0];
    assert.strictEqual(name, 'get');
    assert.strictEqual(getDoc[1], 2, 'GET arity 2');
  });

  it('COMMAND INFO unknown returns empty array', async () => {
    const reply = await sendCommand(port, argv('COMMAND', 'INFO', 'NOSUCHCOMMAND'));
    const v = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(v));
    assert.strictEqual(v.length, 0);
  });

  it('COMMAND unknown subcommand returns error', async () => {
    const reply = await sendCommand(port, argv('COMMAND', 'NOSUCH'));
    const v = tryParseValue(reply, 0).value;
    assert.ok(v && v.error);
    assert.match(v.error, /unknown subcommand|COMMAND/);
  });
});
