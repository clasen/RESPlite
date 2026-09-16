import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPubSubOutput } from '../../src/pubsub/output.js';
import { pubSubConfig } from '../../src/pubsub/config.js';
import { createPubSubBroker } from '../../src/pubsub/broker.js';
import { handleConnection } from '../../src/server/connection.js';
import { encode } from '../../src/resp/encoder.js';
import { tryParseValue } from '../../src/resp/parser.js';

class Socket extends EventEmitter {
  writable = true;
  destroyed = false;
  writableLength = 0;
  blocked = false;
  writes = [];
  ended = false;

  write(buffer) {
    assert.equal(this.destroyed, false);
    assert.equal(this.ended, false);
    this.writes.push(buffer);
    if (this.blocked) this.writableLength += buffer.length;
    return !this.blocked;
  }

  drain(blocked = false) {
    this.writableLength = 0;
    this.blocked = blocked;
    this.emit('drain');
  }

  end() {
    this.ended = true;
  }

  destroy(error) {
    this.destroyed = true;
    this.writable = false;
    if (error) this.emit('error', error);
    this.emit('close');
  }

  command(...args) {
    this.emit('data', encode(args));
  }
}

it('waits for repeated drains without duplicating or reordering accepted buffers', () => {
  const socket = new Socket();
  socket.blocked = true;
  const output = createPubSubOutput(socket);
  const buffers = ['a', 'b', 'c', 'd'].map(value => Buffer.from(value));
  for (const buffer of buffers) assert.equal(output.write(buffer), true);
  assert.equal(socket.destroyed, false);
  assert.deepEqual(socket.writes, buffers.slice(0, 1));
  socket.drain(true);
  assert.deepEqual(socket.writes, buffers.slice(0, 2));
  socket.drain();
  assert.deepEqual(socket.writes, buffers);
  assert.equal(output.write(Buffer.from('e')), true);
  assert.deepEqual(socket.writes.map(String), ['a', 'b', 'c', 'd', 'e']);
});

it('bounds the combined socket buffer and queued bytes, and reports overflow', () => {
  const socket = new Socket();
  const errors = [];
  socket.on('error', error => errors.push(error));
  socket.blocked = true;
  const output = createPubSubOutput(socket);
  const half = Buffer.alloc(pubSubConfig.maxPendingBytes / 2);
  assert.equal(output.write(half), true);
  assert.equal(output.write(half), true);
  assert.equal(socket.destroyed, false);
  assert.equal(output.write(Buffer.from('x')), false);
  assert.equal(socket.destroyed, true);
  assert.equal(errors[0].code, 'PUBSUB_OUTPUT_LIMIT');
  assert.equal(socket.listenerCount('drain'), 0);
  socket.drain();
  assert.equal(socket.writes.length, 1);
  assert.equal(output.write(Buffer.from('after close')), false);
});

it('releases capacity after draining and rejects a single oversized frame', () => {
  const socket = new Socket();
  socket.blocked = true;
  socket.on('error', () => {});
  const output = createPubSubOutput(socket);
  const half = Buffer.alloc(pubSubConfig.maxPendingBytes / 2);
  output.write(half);
  output.write(half);
  socket.drain();
  assert.equal(output.write(half), true);
  assert.equal(socket.destroyed, false);
  assert.equal(output.write(Buffer.alloc(pubSubConfig.maxPendingBytes + 1)), false);
  assert.equal(socket.destroyed, true);
});

it('discards pending output and drain listeners when a subscriber disconnects', () => {
  const socket = new Socket();
  socket.blocked = true;
  const output = createPubSubOutput(socket);
  output.write(Buffer.from('a'));
  output.write(Buffer.from('b'));
  socket.destroy();
  socket.drain();
  assert.equal(socket.listenerCount('drain'), 0);
  assert.deepEqual(socket.writes.map(String), ['a']);
});

it('keeps messages, acknowledgements, normal responses and QUIT in wire order', () => {
  const socket = new Socket();
  const pubSub = createPubSubBroker();
  handleConnection(socket, {}, {}, null, { pubSub });
  socket.command('SUBSCRIBE', 'events');
  socket.blocked = true;
  pubSub.publish(Buffer.from('events'), Buffer.from('first'));
  pubSub.publish(Buffer.from('events'), Buffer.from('second'));
  socket.command('PING', 'alive');
  socket.command('GET', 'forbidden');
  socket.command('UNSUBSCRIBE', 'events');
  socket.command('ECHO', 'normal');
  socket.command('QUIT');
  assert.equal(socket.destroyed, false);
  assert.equal(socket.ended, false);
  assert.equal(socket.writes.length, 2);
  socket.drain(true);
  assert.equal(socket.ended, false);
  socket.drain();
  assert.equal(socket.ended, true);
  const values = socket.writes.map(buffer => tryParseValue(buffer, 0).value);
  const strings = value => value.map(String);
  assert.deepEqual(strings(values[0]), ['subscribe', 'events', '1']);
  assert.deepEqual(strings(values[1]), ['message', 'events', 'first']);
  assert.deepEqual(strings(values[2]), ['message', 'events', 'second']);
  assert.deepEqual(strings(values[3]), ['pong', 'alive']);
  assert.match(values[4].error, /only SUBSCRIBE/);
  assert.deepEqual(strings(values[5]), ['unsubscribe', 'events', '0']);
  assert.equal(String(values[6]), 'normal');
  assert.equal(values[7], 'OK');
});

it('disconnects only the slow subscriber and keeps healthy subscribers receiving', () => {
  const pubSub = createPubSubBroker();
  const slow = new Socket();
  const healthy = new Socket();
  const errors = [];
  handleConnection(slow, {}, { onSocketError: ({ error }) => errors.push(error) }, null, { pubSub });
  handleConnection(healthy, {}, {}, null, { pubSub });
  slow.command('SUBSCRIBE', 'events');
  healthy.command('SUBSCRIBE', 'events');
  slow.blocked = true;
  const payload = Buffer.alloc(pubSubConfig.maxPendingBytes / 3);
  for (let i = 0; i < 4; i++) pubSub.publish(Buffer.from('events'), payload);
  assert.equal(slow.destroyed, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'PUBSUB_OUTPUT_LIMIT');
  assert.equal(healthy.destroyed, false);
  assert.equal(healthy.writes.length, 5);
  assert.equal(pubSub.publish(Buffer.from('events'), Buffer.from('after overflow')), 1);
  assert.equal(healthy.writes.length, 6);
});
