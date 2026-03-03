import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RESPReader } from '../../src/resp/parser.js';
import { encode } from '../../src/resp/encoder.js';

describe('RESP parser', () => {
  it('parses simple string', () => {
    const r = new RESPReader();
    r.feed(Buffer.from('+OK\r\n', 'ascii'));
    const cmd = r.parseCommands();
    assert.equal(cmd.length, 0); // simple string is not a command (array)
  });

  it('parses array command', () => {
    const r = new RESPReader();
    r.feed(Buffer.from('*2\r\n$4\r\nPING\r\n$5\r\nhello\r\n', 'ascii'));
    const cmd = r.parseOne();
    assert.equal(cmd.done, true);
    assert.ok(Array.isArray(cmd.value));
    assert.equal(cmd.value.length, 2);
    assert.ok(Buffer.isBuffer(cmd.value[0]));
    assert.equal(cmd.value[0].toString(), 'PING');
    assert.equal(cmd.value[1].toString(), 'hello');
  });

  it('parses multiple commands in one chunk', () => {
    const r = new RESPReader();
    r.feed(Buffer.from('*1\r\n$4\r\nPING\r\n*1\r\n$4\r\nPING\r\n', 'ascii'));
    const commands = r.parseCommands();
    assert.equal(commands.length, 2);
    assert.equal(commands[0][0].toString(), 'PING');
    assert.equal(commands[1][0].toString(), 'PING');
  });

  it('handles fragmented input', () => {
    const r = new RESPReader();
    r.feed(Buffer.from('*2\r\n$4\r\n', 'ascii'));
    let commands = r.parseCommands();
    assert.equal(commands.length, 0);
    r.feed(Buffer.from('PING\r\n$4\r\n', 'ascii'));
    commands = r.parseCommands();
    assert.equal(commands.length, 0);
    r.feed(Buffer.from('test\r\n', 'ascii'));
    commands = r.parseCommands();
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0].toString(), 'PING');
    assert.equal(commands[0][1].toString(), 'test');
  });

  it('parses bulk string as Buffer', () => {
    const r = new RESPReader();
    r.feed(Buffer.from('*1\r\n$3\r\nfoo\r\n', 'ascii'));
    const commands = r.parseCommands();
    assert.equal(commands.length, 1);
    assert.ok(Buffer.isBuffer(commands[0][0]));
    assert.equal(commands[0][0].toString('utf8'), 'foo');
  });
});
