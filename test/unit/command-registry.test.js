import { it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../../src/commands/registry.js';

it('keeps arguments binary until an error hook needs text', () => {
  const bytes = Buffer.from([0, 255, 195, 40]);
  let conversions = 0;
  bytes.toString = function (...args) {
    conversions++;
    return Buffer.prototype.toString.apply(this, args);
  };
  const hooks = {
    onUnknownCommand: () => assert.fail('unexpected unknown command'),
    onCommandError: () => assert.fail('unexpected command error'),
  };
  assert.equal(dispatch({}, [Buffer.from('ECHO'), bytes], hooks).result, bytes);
  assert.equal(conversions, 0);
  assert.match(dispatch({}, [Buffer.from('UNKNOWN'), bytes]).error, /not supported/);
  assert.match(dispatch({}, [Buffer.from('ECHO'), bytes], {
    commandPolicy: { disabled: ['ECHO'] },
  }).error, /not supported/);
  assert.match(dispatch({}, [Buffer.from('HGET'), bytes]).error, /arguments/);
  assert.match(dispatch({ get() { throw new Error('failure'); } }, [Buffer.from('GET'), bytes]).error, /failure/);
  assert.equal(conversions, 0);
});

it('preserves text and metadata in unknown, blocked, returned and thrown error hooks', () => {
  const bytes = Buffer.from([0, 255, 195, 40]);
  const events = [];
  const context = {
    connectionId: 7,
    clientAddress: '127.0.0.1:1234',
    onUnknownCommand: (event) => events.push(event),
    onCommandError: (event) => events.push(event),
  };
  dispatch({}, [Buffer.from('unknown'), bytes, 42], context);
  dispatch({}, [Buffer.from('echo'), bytes], { ...context, commandPolicy: { disabled: ['ECHO'] } });
  dispatch({}, [Buffer.from('hget'), bytes], context);
  dispatch({ get() { throw new Error('failure'); } }, [Buffer.from('get'), bytes], context);
  assert.deepEqual(events.map((e) => e.argv), [
    ['unknown', '\u0000\ufffd\ufffd(', '42'], ['echo', '\u0000\ufffd\ufffd('],
    ['hget', '\u0000\ufffd\ufffd('], ['get', '\u0000\ufffd\ufffd('],
  ]);
  assert.deepEqual(events.map((e) => e.command), ['UNKNOWN', 'ECHO', 'HGET', 'GET']);
  assert.deepEqual(events.slice(0, 2).map((e) => e.argsCount), [2, 1]);
  assert.match(events[2].error, /arguments/);
  assert.equal(events[3].error, 'ERR failure');
  for (const event of events) {
    assert.equal(event.connectionId, 7);
    assert.equal(event.clientAddress, '127.0.0.1:1234');
  }
});
