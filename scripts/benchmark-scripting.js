import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createClient } from 'redis';
import { LuaFactory } from 'wasmoon';
import fengari from 'fengari';
import { createRESPlite } from '../src/embed.js';
import { createWasmoonScripting, createFengariScripting } from '../src/scripting/index.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID, createHash } from 'node:crypto';

import { USERNAME_SCRIPT } from '../test/helpers/scripting.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = { rounds: 3, warmup: 200, sequential: 2000, concurrent: 8000, clients: 8, watchdogMs: 60000 };

if (process.argv[2] === 'server') {
  const dir = await mkdtemp('/tmp/resplite-scripting-bench-');
  const scripting = process.argv[3] === 'Fengari' ? createFengariScripting(fengari)
    : createWasmoonScripting(await new LuaFactory().getLuaModule());
  const server = await createRESPlite({
    db: `${dir}/bench.db`, scripting, gracefulShutdown: false,
  });
  process.send({ ready: true, pid: process.pid, cwd: process.cwd(), port: server.port, db: `${dir}/bench.db` });
  process.on('message', async (message) => {
    if (message.kind === 'stats') {
      if (message.gc) global.gc();
      process.send({ id: message.id, memory: process.memoryUsage(), cpu: process.cpuUsage() });
    } else if (message.kind === 'close') {
      await server.close();
      await rm(dir, { recursive: true, force: true });
      process.exit(0);
    }
  });
} else {
  const prefix = `__resplite_perf_${randomUUID()}`;
  const keys = [`${prefix}:names`, `${prefix}:owners`];
  const servers = [];
  let request = 0;
  async function stats(target, gc = false) {
    const child = servers.find((s) => s.name === target.name)?.child;
    if (!child) return null;
    const id = ++request;
    return new Promise((resolve) => {
      const receive = (message) => { if (message.id === id) { child.off('message', receive); resolve(message); } };
      child.on('message', receive); child.send({ kind: 'stats', id, gc });
    });
  }
  const targets = [];
  const results = [];
  const snapshots = [];
  try {
    for (const name of ['Wasmoon', 'Fengari']) {
      const child = fork(import.meta.filename, ['server', name], {
        cwd: root, execArgv: ['--expose-gc'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      const entry = { name, child };
      servers.push(entry);
      entry.ready = await new Promise((resolve, reject) => {
        const finish = (error, ready) => {
          clearTimeout(timer);
          child.off('message', onReady);
          child.off('error', onError);
          child.off('exit', onExit);
          if (error) reject(error); else resolve(ready);
        };
        const onReady = (ready) => finish(null, ready);
        const onError = (error) => finish(error);
        const onExit = (code) => finish(new Error(`server exited ${code}`));
        const timer = setTimeout(() => finish(new Error('Server startup timed out')), config.watchdogMs);
        child.once('message', onReady);
        child.once('error', onError);
        child.once('exit', onExit);
      });
      console.log('OWNED_SERVER', name, JSON.stringify(entry.ready));
    }
    for (const {name, ready: {port}} of [{name: 'Redis Docker', ready: {port: 6379}}, ...servers]) {
      const clients = [];
      targets.push({ name, clients });
      for (let i = 0; i < config.clients; i++) {
        const client = createClient({ socket: { host: '127.0.0.1', port, reconnectStrategy: false } });
        clients.push(client);
        client.on('error', (error) => console.error(`${name}: ${error.message}`));
        await client.connect();
      }
      for (let i = 0; i < config.clients; i++) {
        await clients[0].hSet(keys[0], String(i), `Name_${i}_0`);
        await clients[0].hSet(keys[1], `name_${i}_0`, String(i));
      }
      for (let i = 0; i < 50; i++) await clients[0].hSet(keys[1], `taken${i}`, 'occupied');
      await clients[0].scriptLoad('return 1');
      await clients[0].scriptLoad(USERNAME_SCRIPT);
    }
    const sha = createHash('sha1').update(USERNAME_SCRIPT).digest('hex');
    const constantSha = createHash('sha1').update('return 1').digest('hex');
    const workloads = [
      { name: 'PING', run: (c) => c.ping(), expected: 'PONG' },
      { name: 'HGET', run: (c) => c.hGet(keys[0], '0') },
      { name: 'constant EVAL', run: (c) => c.eval('return 1'), expected: 1 },
      { name: 'constant EVALSHA', run: (c) => c.evalSha(constantSha), expected: 1 },
      ...['EVAL', 'EVALSHA'].flatMap((method) => ['ensure', 'rename'].map((mode) => ({
        name: `${mode} ${method}`,
        run: (c, i, worker) => {
          const options = { keys, arguments: [String(worker), mode === 'ensure' ? 'ensure' : 'set', `Name_${worker}_${i % 2}`] };
          return method === 'EVAL' ? c.eval(USERNAME_SCRIPT, options) : c.evalSha(sha, options);
        },
      }))),
      { name: '50 conflicts EVALSHA', run: (c, i, worker) => c.evalSha(sha, {
        keys, arguments: [String(worker), 'set', ...Array.from({ length: 50 }, (_, j) => `taken${j}`), `Name_${worker}_${i % 2}`],
      }) },
    ];
    async function measure(target, workload, round, concurrency, count) {
      const verify = (value) => workload.expected !== undefined
        ? assert.equal(value, workload.expected) : assert.match(value, /^Name_/);
      for (let i = 0; i < config.warmup; i++) verify(await workload.run(target.clients[i % concurrency], i, i % concurrency));
      const before = await stats(target);
      const latencies = [];
      const start = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
        for (let i = 0; i < count / concurrency; i++) {
          const then = performance.now();
          const value = await workload.run(target.clients[worker], i, worker);
          latencies.push(performance.now() - then);
          verify(value);
        }
      }));
      const elapsed = performance.now() - start;
      const after = await stats(target);
      latencies.sort((a, b) => a - b);
      const row = {
        target: target.name, workload: workload.name, round, concurrency, count,
        ops: count * 1000 / elapsed, p50: latencies[Math.floor(count * .5)],
        p95: latencies[Math.floor(count * .95)], p99: latencies[Math.floor(count * .99)],
        cpuUsPerOp: before ? ((after.cpu.user - before.cpu.user) + (after.cpu.system - before.cpu.system)) / count : null,
      };
      results.push(row);
      console.log('RESULT', JSON.stringify(row));
    }
    async function guardedMeasure(...args) {
      let timer;
      try {
        await Promise.race([
          measure(...args),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Benchmark watchdog expired')), config.watchdogMs);
          }),
        ]);
      } finally { clearTimeout(timer); }
    }
    for (const target of targets) snapshots.push({target: target.name, ...await stats(target, true)});
    for (let round = 1; round <= config.rounds; round++) {
      const offset = (round - 1) % targets.length;
      const order = [...targets.slice(offset), ...targets.slice(0, offset)];
      for (const workload of workloads) for (const target of order) await guardedMeasure(target, workload, round, 1, config.sequential);
      for (const workload of workloads.filter((w) => ['ensure EVALSHA', 'rename EVALSHA'].includes(w.name))) {
        for (const target of order) await guardedMeasure(target, workload, round, config.clients, config.concurrent);
      }
      for (const target of targets) snapshots.push({target: target.name, ...await stats(target, true)});
    }
    for (const target of targets) {
      const names = await target.clients[0].hGetAll(keys[0]);
      for (const [hid, name] of Object.entries(names)) assert.equal(await target.clients[0].hGet(keys[1], name.toLowerCase()), hid);
    }
    const report = { node: process.version, config, prefix, servers: servers.map(s => ({ name: s.name, ...s.ready })), results, snapshots };
    if (process.env.BENCH_OUTPUT) await writeFile(process.env.BENCH_OUTPUT, JSON.stringify(report, null, 2));
    console.log('COMPLETE', JSON.stringify({ samples: results.reduce((n, row) => n + row.count, 0), snapshots }));
  } finally {
    const cleanup = await Promise.allSettled([
      ...targets.map(async (target) => {
        try {
          if (target.name === 'Redis Docker' && target.clients[0]?.isReady) {
            await target.clients[0].del(keys);
          }
        } finally {
          const disconnected = await Promise.allSettled(target.clients.map(async (client) => {
            if (client.isOpen) await client.disconnect();
          }));
          const errors = disconnected.filter(result => result.status === 'rejected').map(result => result.reason);
          if (errors.length) throw new AggregateError(errors, 'Client cleanup failed');
        }
      }),
      ...servers.map(async ({ child, ready }) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), config.watchdogMs);
        try {
          if (ready && child.connected) {
            child.send({ kind: 'close' }, (error) => { if (error) child.kill('SIGTERM'); });
          } else child.kill('SIGTERM');
          await exited;
        } finally { clearTimeout(killTimer); }
        console.log('OWNED_SERVER_CLOSED', child.pid);
      }),
    ]);
    const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Benchmark cleanup failed');
  }
}
