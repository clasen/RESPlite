import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { LuaFactory } from 'wasmoon';
import fengari from 'fengari';
import { createClient, commandOptions } from 'redis';
import { createRESPlite, createRESPliteGroup, createEngine, openDb } from '../../src/embed.js';
import { createWasmoonScripting, createFengariScripting } from '../../src/scripting/index.js';
import { createServer } from '../../src/server/tcp-server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';
import { USERNAME_SCRIPT } from '../helpers/scripting.js';

let lua;
before(async () => { lua = await new LuaFactory().getLuaModule(); });

for (const [name, createScripting] of [
  ['Wasmoon', (options) => createWasmoonScripting(lua, options)],
  ['Fengari', (options) => createFengariScripting(fengari, options)],
]) {
  async function fixture(t, options = {}, limits = {}) {
    const scripting = createScripting(limits);
    const server = await createRESPlite({ scripting, gracefulShutdown: false, ...options });
    const client = createClient({ socket: { port: server.port, host: server.host, reconnectStrategy: false } });
    t.after(async () => {
      if (client.isOpen) await client.disconnect();
      await server.close();
    });
    await client.connect();
    return { server, client, scripting };
  }

  describe(`${name} scripting over RESP`, () => {
    it('runs EVAL and EVALSHA through the redis client with binary replies', async (t) => {
      const { client } = await fixture(t);
      const bytes = Buffer.from([0, 255, 128, 1]);
      const source = "redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]); return redis.call('HGET', KEYS[1], ARGV[1])";
      const opts = { keys: ['binary'], arguments: ['field', bytes] };
      assert.deepEqual(await client.eval(commandOptions({ returnBuffers: true }), source, opts), bytes);
      const sha = createHash('sha1').update(source).digest('hex');
      assert.deepEqual(await client.scriptExists([sha]), [true]);
      assert.deepEqual(await client.evalSha(commandOptions({ returnBuffers: true }), sha, opts), bytes);
      await client.scriptFlush();
      await assert.rejects(client.evalSha(sha, opts), /^Error: NOSCRIPT/);
      const loaded = await client.scriptLoad('return ARGV[1]');
      assert.equal(await client.evalSha(loaded, { arguments: ['loaded'] }), 'loaded');
    });

    it('supports username assignment, ensure, rename and exhaustion', async (t) => {
      const { client } = await fixture(t);
      const assign = (hid, mode, ...candidates) => client.eval(USERNAME_SCRIPT, {
        keys: ['names', 'owners'], arguments: [hid, mode, ...candidates],
      });
      assert.equal(await assign('a', 'ensure', 'Martin'), 'Martin');
      assert.equal(await assign('a', 'ensure', 'Other'), 'Martin');
      assert.equal(await assign('b', 'set', 'Martin', 'Bob'), 'Bob');
      assert.equal(await assign('c', 'set', 'MARTIN', 'BOB'), null);
      assert.equal(await assign('a', 'set', 'Pedro'), 'Pedro');
      assert.equal(await client.hGet('owners', 'martin'), null);
      assert.equal(await assign('a', 'set', 'PEDRO'), 'PEDRO');
      await client.hSet('owners', 'pedro', 'wrong');
      await assert.rejects(assign('a', 'set', 'Another'), /inconsistent username owner/);
      assert.equal(await client.hGet('names', 'a'), 'PEDRO');
      assert.equal(await client.hGet('owners', 'another'), null);
    });

    it('gives a contested username to exactly one concurrent client', async (t) => {
      const { client } = await fixture(t);
      const clients = await Promise.all(Array.from({ length: 12 }, async () => {
        const c = client.duplicate();
        await c.connect();
        t.after(async () => { if (c.isOpen) await c.disconnect(); });
        return c;
      }));
      const results = await Promise.all(clients.map((c, i) => c.eval(USERNAME_SCRIPT, {
        keys: ['names', 'owners'], arguments: [String(i), 'set', 'Shared'],
      })));
      const winner = results.findIndex((name) => name === 'Shared');
      assert.equal(results.filter((name) => name !== null).length, 1);
      assert.equal(await client.hGet('owners', 'shared'), String(winner));
      assert.deepEqual({ ...await client.hGetAll('names') }, { [winner]: 'Shared' });
    });

    it('keeps capabilities, script cache and command metadata local to each instance', async (t) => {
      const group = await createRESPliteGroup({
        enabled: { scripting: createScripting() },
        other: { scripting: createScripting() },
        plain: {},
      }, { gracefulShutdown: false });
      t.after(() => group.close());
      const command = async (name, ...args) => tryParseValue(await sendCommand(group.servers[name].port, argv(...args)), 0).value;
      const sha = String(await command('enabled', 'SCRIPT', 'LOAD', 'return 1'));
      assert.match((await command('other', 'EVALSHA', sha, 0)).error, /^NOSCRIPT/);
      assert.match((await command('plain', 'EVAL', 'return 1', 0)).error, /not supported/);
      const plain = await command('plain', 'COMMAND');
      const enabled = await command('enabled', 'COMMAND');
      assert.equal(enabled.length - plain.length, 3);
      assert.equal(plain.some((doc) => String(doc[0]) === 'eval'), false);
      const info = await command('enabled', 'COMMAND', 'INFO', 'EVAL');
      assert.equal(info[0][1], -3);
      assert.ok(info[0][2].map(String).includes('movablekeys'));
    });

    it('respects command aliases and disabled commands without duplicate error hooks', async (t) => {
      const errors = [];
      const unknown = [];
      const { client } = await fixture(t, {
        commandPolicy: { rename: { HGET: 'READ_HASH' }, disabled: ['HDEL'] },
        hooks: { onCommandError: (e) => errors.push(e), onUnknownCommand: (e) => unknown.push(e) },
      });
      await client.hSet('h', 'f', 'value');
      assert.equal(await client.eval("return redis.call('READ_HASH','h','f')"), 'value');
      await assert.rejects(client.eval("return redis.call('HGET','h','f')"), /not supported/);
      await assert.rejects(client.eval("return redis.call('HDEL','h','f')"), /not supported/);
      assert.equal(errors.length, 2);
      assert.deepEqual(errors.map((e) => e.command), ['EVAL', 'EVAL']);
      assert.equal(unknown.length, 0);
      assert.equal(await client.eval("local e=redis.pcall('HGET','h','f'); return e.err ~= nil"), 1);
      assert.equal(errors.length, 2);
    });

    it('rejects plugin reuse and closes on failed startup without closing the original owner', async (t) => {
      const { server, scripting, client } = await fixture(t);
      await assert.rejects(createRESPlite({ scripting, gracefulShutdown: false }), /another server/);
      assert.equal(await client.eval('return 42'), 42);
      const failed = createScripting();
      await assert.rejects(createRESPlite({ scripting: failed, port: server.port, gracefulShutdown: false }), /EADDRINUSE/);
      assert.throws(() => failed.attach({}), /closed/);
      const invalid = createScripting();
      await assert.rejects(createRESPlite({ scripting: invalid, commandPolicy: { rename: { DOES_NOT_EXIST: 'X' } } }), /unknown command/);
      assert.throws(() => invalid.attach({}), /closed/);
    });

    it('discards cache on restart and recovers from timeout with prior writes intact', async (t) => {
      const { client, server } = await fixture(t, {}, { timeoutMs: 300 });
      const sha = await client.scriptLoad('return 1');
      await assert.rejects(client.eval("redis.call('SET','before','saved'); while true do end"), /timed out/);
      assert.equal(await client.get('before'), 'saved');
      assert.equal(await client.eval('return 42'), 42);
      await client.disconnect();
      await server.close();
      const fresh = await fixture(t);
      await assert.rejects(fresh.client.evalSha(sha), /^Error: NOSCRIPT/);
    });

    it('makes the final list state visible to an already blocked socket', async (t) => {
      const db = openDb(':memory:');
      const engine = createEngine({ db });
      const scripting = createScripting();
      const server = createServer({ engine, scripting });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const client = createClient({ socket: { port: server.address().port, host: '127.0.0.1' } });
      const blocked = client.duplicate();
      await Promise.all([client.connect(), blocked.connect()]);
      t.after(async () => {
        await Promise.all([client.disconnect(), blocked.disconnect()]);
        await new Promise((resolve) => server.close(resolve));
        db.close();
      });
      let registered;
      const ready = new Promise((resolve) => { registered = resolve; });
      const register = engine._blockingManager.registerWaiter;
      engine._blockingManager.registerWaiter = (...args) => {
        const result = register(...args);
        registered();
        return result;
      };
      const result = blocked.blPop('q', 2);
      await ready;
      assert.equal(await client.eval("redis.call('RPUSH','q','initial'); redis.call('LSET','q',0,'final'); return redis.call('LLEN','q')"), 1);
      assert.deepEqual(await result, { key: 'q', element: 'final' });
    });

    it('supports prepared plugins in synchronous startServer and closes on SIGTERM', { timeout: 10000 }, async (t) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import {LuaFactory} from 'wasmoon';
        import fengari from 'fengari';
        import {createWasmoonScripting,createFengariScripting} from 'resplite/scripting';
        import {startServer} from 'resplite';
        const module = await new LuaFactory().getLuaModule();
        const scripting = ${name === 'Fengari' ? 'createFengariScripting(fengari)' : 'createWasmoonScripting(module)'};
        assert.equal(startServer({port:0, dbPath:':memory:', scripting}), undefined);
        process.on('exit', () => assert.throws(() => scripting.attach({}), /closed/));
      `], { cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      });
      const port = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${stderr}`)));
        child.stdout.on('data', (chunk) => {
          const match = String(chunk).match(/listening on port (\d+)/);
          if (match) resolve(Number(match[1]));
        });
      });
      t.diagnostic(`Owned startServer PID=${child.pid}, cwd=${process.cwd()}, port=${port}`);
      assert.equal(tryParseValue(await sendCommand(port, argv('EVAL', 'return 42', 0)), 0).value, 42);
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      assert.deepEqual(await exited, [0, null], stderr);
    });
  });

}
