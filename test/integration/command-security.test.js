/**
 * Integration tests for command hardening policy (rename/disable).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

function parseResp(buffer) {
  const parsed = tryParseValue(buffer, 0);
  return parsed ? parsed.value : null;
}

function asUtf8(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

describe('command hardening policy', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer({
      commandPolicy: {
        rename: {
          KEYS: 'SAFE_KEYS',
          DEL: 'RMDEL',
        },
        disabled: ['MONITOR'],
      },
    });
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('renamed command is available only through alias', async () => {
    const setReply = parseResp(await sendCommand(port, argv('SET', 'policy:k1', 'v1')));
    assert.equal(asUtf8(setReply), 'OK');

    const aliasReply = parseResp(await sendCommand(port, argv('SAFE_KEYS', 'policy:*')));
    assert.ok(Array.isArray(aliasReply));
    assert.ok(aliasReply.map(asUtf8).includes('policy:k1'));

    const oldNameReply = parseResp(await sendCommand(port, argv('KEYS', 'policy:*')));
    assert.ok(oldNameReply && oldNameReply.error);
    assert.equal(asUtf8(oldNameReply.error), 'ERR command not supported yet');
  });

  it('explicitly disabled command returns unsupported', async () => {
    const reply = parseResp(await sendCommand(port, argv('MONITOR')));
    assert.ok(reply && reply.error);
    assert.equal(asUtf8(reply.error), 'ERR command not supported yet');
  });

  it('COMMAND only exposes visible names and keeps canonical metadata', async () => {
    const listReply = parseResp(await sendCommand(port, argv('COMMAND')));
    assert.ok(Array.isArray(listReply));
    const names = listReply.map((doc) => asUtf8(doc[0]).toUpperCase());
    assert.ok(names.includes('SAFE_KEYS'));
    assert.ok(names.includes('RMDEL'));
    assert.ok(!names.includes('KEYS'));
    assert.ok(!names.includes('DEL'));
    assert.ok(!names.includes('MONITOR'));

    const infoReply = parseResp(await sendCommand(port, argv('COMMAND', 'INFO', 'RMDEL')));
    assert.ok(Array.isArray(infoReply));
    assert.equal(infoReply.length, 1);
    const rmDelDoc = infoReply[0];
    assert.equal(asUtf8(rmDelDoc[0]), 'rmdel');
    assert.equal(rmDelDoc[1], -2);
    const flags = rmDelDoc[2].map(asUtf8);
    assert.ok(flags.includes('write'));
  });

  it('renamed write command executes through alias and blocks original', async () => {
    await sendCommand(port, argv('SET', 'policy:del', 'to-delete'));

    const aliasDeleteReply = parseResp(await sendCommand(port, argv('RMDEL', 'policy:del')));
    assert.equal(aliasDeleteReply, 1);

    const originalDeleteReply = parseResp(await sendCommand(port, argv('DEL', 'policy:del')));
    assert.ok(originalDeleteReply && originalDeleteReply.error);
    assert.equal(asUtf8(originalDeleteReply.error), 'ERR command not supported yet');
  });
});
