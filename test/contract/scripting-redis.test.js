import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { LuaFactory } from 'wasmoon';
import fengari from 'fengari';
import { createClient } from 'redis';
import { createRESPlite } from '../../src/embed.js';
import { createWasmoonScripting, createFengariScripting } from '../../src/scripting/index.js';
import { USERNAME_SCRIPT } from '../helpers/scripting.js';

it('matches Redis username results and stored hashes, and measures EVAL/EVALSHA latency', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp('/tmp/resplite-lua-');
  const socket = `${dir}/redis.sock`;
  const servers = [];
  const clients = [];
  const redis = spawn('redis-server', [
    '--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--dir', dir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    for (const client of clients) if (client.isOpen) await client.disconnect();
    for (const server of servers) await server.close();
    if (redis.pid && redis.exitCode === null && redis.signalCode === null) {
      const exited = once(redis, 'exit');
      redis.kill('SIGTERM');
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Redis startup timed out: ${output}`)), 5000);
      const finish = (error) => {
        clearTimeout(timer);
        redis.off('error', onError);
        redis.off('exit', onExit);
        redis.stdout.off('data', onData);
        if (error) reject(error); else resolve();
      };
      const onError = (error) => finish(error);
      const onExit = (code) => finish(new Error(`Redis exited ${code}: ${output}`));
      const onData = (chunk) => {
        output += chunk;
        if (output.toLowerCase().includes('ready to accept connections')) finish();
      };
      redis.once('error', onError);
      redis.once('exit', onExit);
      redis.stdout.on('data', onData);
    });
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('redis-server is not installed');
    throw error;
  }
  t.diagnostic(`Owned Redis PID=${redis.pid}, cwd=${dir}, TCP disabled, socket=${socket}`);
  const lua = await new LuaFactory().getLuaModule();
  clients.push(createClient({ socket: { path: socket, reconnectStrategy: false } }));
  for (const scripting of [createWasmoonScripting(lua), createFengariScripting(fengari)]) {
    const server = await createRESPlite({ scripting, gracefulShutdown: false });
    servers.push(server);
    t.diagnostic(`Owned RESPlite PID=${process.pid}, cwd=${process.cwd()}, port=${server.port}`);
    clients.push(createClient({ socket: { host: server.host, port: server.port, reconnectStrategy: false } }));
  }
  for (const client of clients) {
    await client.connect();
  }

  const scenarios = [
    { name: 'initial', args: ['a', 'set', 'Martin'] },
    { name: 'ensure', names: { a: 'Martin' }, owners: { martin: 'a' }, args: ['a', 'ensure', 'Other'] },
    { name: 'rename', names: { a: 'Martin' }, owners: { martin: 'a' }, args: ['a', 'set', 'Pedro'] },
    { name: 'case only', names: { a: 'Martin' }, owners: { martin: 'a' }, args: ['a', 'set', 'MARTIN'] },
    { name: 'occupied candidate', owners: { martin: 'b' }, args: ['a', 'set', 'Martin', 'Pedro'] },
    { name: 'same owner', owners: { martin: 'a' }, args: ['a', 'set', 'Martin'] },
    { name: 'inconsistent', names: { a: 'Martin' }, owners: { martin: 'b' }, args: ['a', 'set', 'Pedro'] },
    { name: 'missing reverse owner', names: { a: 'Martin' }, args: ['a', 'set', 'Pedro'] },
    { name: 'all occupied', owners: { martin: 'b', pedro: 'c' }, args: ['a', 'set', 'Martin', 'Pedro'] },
    { name: 'no candidates', args: ['a', 'set'] },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const outcomes = [];
      for (const client of clients) {
        await client.flushDb();
        if (scenario.names) await client.hSet('names', scenario.names);
        if (scenario.owners) await client.hSet('owners', scenario.owners);
        let result;
        try {
          result = { value: await client.eval(USERNAME_SCRIPT, { keys: ['names', 'owners'], arguments: scenario.args }) };
        } catch (error) {
          result = { error: error.message };
        }
        outcomes.push({ result, names: await client.hGetAll('names'), owners: await client.hGetAll('owners') });
      }
      assert.deepEqual(outcomes[1], outcomes[0], 'Wasmoon');
      assert.deepEqual(outcomes[2], outcomes[0], 'Fengari');
    });
  }

  for (const [index, client] of clients.entries()) {
    const opts = { keys: ['bench:names', 'bench:owners'], arguments: ['id', 'ensure', 'Name'] };
    const sha = await client.scriptLoad(USERNAME_SCRIPT);
    for (const method of ['EVAL', 'EVALSHA']) {
      const execute = () => method === 'EVAL' ? client.eval(USERNAME_SCRIPT, opts) : client.evalSha(sha, opts);
      for (let i = 0; i < 25; i++) await execute();
      const samples = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        assert.equal(await execute(), 'Name');
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      t.diagnostic(`${['Redis Unix socket', 'Wasmoon TCP', 'Fengari TCP'][index]} ${method}: n=100 p50=${samples[50].toFixed(3)}ms p95=${samples[95].toFixed(3)}ms; Node ${process.version}`);
    }
  }
});
