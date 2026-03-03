import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('Restart persistence', () => {
  it('data survives server restart', async () => {
    const s1 = await createTestServer();
    const port = s1.port;
    const dbPath = s1.dbPath;
    await sendCommand(port, argv('SET', 'persist_key', 'persist_val'));
    await sendCommand(port, argv('HSET', 'user:1', 'name', 'Alice'));
    await s1.closeAsync();
    s1.db.close();
    const s2 = await createTestServer({ dbPath });
    const getReply = await sendCommand(s2.port, argv('GET', 'persist_key'));
    assert.equal(getReply.toString('utf8'), '$11\r\npersist_val\r\n');
    const hget = await sendCommand(s2.port, argv('HGET', 'user:1', 'name'));
    assert.equal(hget.toString('utf8'), '$5\r\nAlice\r\n');
    await s2.closeAsync();
  });
});
