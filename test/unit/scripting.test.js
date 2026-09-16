import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { LuaFactory } from 'wasmoon';
import fengari from 'fengari';
import { createWasmoonScripting, createFengariScripting } from '../../src/scripting/index.js';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
import { dispatch } from '../../src/commands/registry.js';
import { encode } from '../../src/resp/encoder.js';
import { tryParseValue } from '../../src/resp/parser.js';
import { runLua } from '../../src/scripting/runtime.js';
import { DEFAULTS } from '../../src/scripting/config.js';

let lua;
before(async () => { lua = await new LuaFactory().getLuaModule(); });

for (const [name, createScripting] of [
  ['Wasmoon', (options) => createWasmoonScripting(lua, options)],
  ['Fengari', (options) => createFengariScripting(fengari, options)],
]) {
  function fixture(t, options = {}, engineOptions = {}) {
    const db = openDb(':memory:');
    const engine = createEngine({ db, ...engineOptions });
    const scripting = createScripting(options);
    scripting.attach(engine);
    const context = { scripting };
    t.after(() => { scripting.close(); db.close(); });
    const command = (...args) => dispatch(engine, args.map((v) => Buffer.isBuffer(v) ? v : Buffer.from(String(v))), context);
    return { engine, scripting, context, command, eval: (code, ...args) => command('EVAL', code, ...args) };
  }

  describe(`${name} scripting`, () => {
    it('preserves every byte through arguments, commands and Lua string operations', (t) => {
      const f = fixture(t);
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      const result = f.eval(`redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
        return {KEYS[1], redis.call('HGET', KEYS[1], ARGV[1]), string.len(ARGV[2]), string.sub(ARGV[2], 1, 3)}`,
      1, bytes, bytes, bytes);
      assert.deepEqual(result.result, [bytes, bytes, 256, bytes.subarray(0, 3)]);
      assert.deepEqual(f.eval(Buffer.concat([Buffer.from('return "'), Buffer.from([255]), Buffer.from('"')]), 0).result, Buffer.from([255]));
    });

    it('converts RESP2 values, holes, states and nested errors', (t) => {
      const f = fixture(t);
      const result = f.eval(`return {redis.call('GET','missing'),true,1.9,-1.9,
        redis.call('SET','k','v'),redis.pcall('HGET','k','f'),{1,nil,3}}`, 0);
      assert.deepEqual(result.result.slice(0, 5), [null, 1, 1, -1, { simple: 'OK' }]);
      assert.match(result.result[5].error, /WRONGTYPE/);
      assert.deepEqual(result.result[6], [1]);
      const wire = tryParseValue(encode(result.result), 0).value;
      assert.equal(wire[4], 'OK');
      assert.match(String(wire[5].error), /WRONGTYPE/);
      assert.deepEqual(f.eval('return false', 0), { result: null });
      assert.deepEqual(f.eval('return', 0), { result: null });
      assert.deepEqual(f.eval('return 1, 2', 0), { result: 1 });
      assert.match(f.eval('return 1/0', 0).error, /safe integer/);
      assert.match(f.eval('local a={} a[1]=a return a', 0).error, /cyclic/);
      assert.equal(f.eval(`return redis.error_reply('bad\\r\\nreply')`, 0).error, 'bad  reply');
    });

    it('keeps prior writes after errors and isolates global mutations', (t) => {
      const f = fixture(t);
      assert.match(f.eval(`redis.call('SET','k','v'); redis.call('HSET','k','f','x')`, 0).error, /WRONGTYPE/);
      assert.equal(f.engine.get('k').toString(), 'v');
      assert.match(f.eval(`return redis.call('GET', {})`, 0).error, /arguments/);
      assert.match(f.eval(`return redis.call()`, 0).error, /argument/);
      f.eval('custom = 10; string.lower = nil; return 1', 0);
      assert.deepEqual(f.eval('return {custom == nil, string.lower("ABC")}', 0).result, [1, Buffer.from('abc')]);
    });

    it('does not expose host capabilities or permit nested/administrative commands', (t) => {
      const f = fixture(t);
      for (const name of ['os', 'io', 'debug', 'package', 'require', 'load', 'loadfile', 'dofile', 'coroutine', 'js', 'Promise', '_G', 'setmetatable']) {
        assert.equal(f.eval(`return ${name} == nil`, 0).result, 1, name);
      }
      assert.equal(f.eval('return string.dump == nil', 0).result, 1);
      for (const name of ['EVAL', 'SCRIPT', 'FLUSHDB', 'PUBLISH', 'BLPOP', 'FT.SEARCH', 'CLIENT']) {
        assert.match(f.eval(`return redis.pcall('${name}')`, 0).error, /not allowed/);
      }
      assert.match(f.eval(Buffer.from([27, 76, 117, 97]), 0).error, /binary/);
    });

    it('validates numkeys and script source before execution', (t) => {
      const f = fixture(t, { maxScriptBytes: 64 });
      for (const value of ['1x', '', '1.5', '9007199254740992', Buffer.from([0xb1])]) {
        assert.match(f.eval('return 1', value).error, /integer/);
      }
      assert.match(f.eval('return 1', -1).error, /negative/);
      assert.match(f.eval('return 1', 2, 'a').error, /number of args/);
      assert.match(f.eval('return 1').error, /arguments/);
      assert.match(f.eval(' '.repeat(65), 0).error, /source byte limit/);
      assert.match(f.command('SCRIPT', 'LOAD', 'return )').error, /user_script/);
    });

    it('caches valid scripts, refreshes LRU, flushes and enforces byte capacity', (t) => {
      const f = fixture(t, { maxCachedScripts: 2, maxCacheBytes: 24 });
      const a = f.command('SCRIPT', 'LOAD', 'return 1').result;
      const b = f.command('SCRIPT', 'LOAD', 'return 2').result;
      assert.deepEqual(f.command('EVALSHA', a, 0), { result: 1 });
      const c = f.command('SCRIPT', 'LOAD', 'return 3').result;
      assert.deepEqual(f.command('SCRIPT', 'EXISTS', a, b, c).result, [1, 0, 1]);
      assert.match(f.command('EVALSHA', b, 0).error, /^NOSCRIPT/);
      assert.match(f.command('SCRIPT', 'FLUSH', 'ASYNC').error, /unsupported/);
      assert.deepEqual(f.command('SCRIPT', 'FLUSH', 'SYNC').result, { simple: 'OK' });
      assert.deepEqual(f.command('SCRIPT', 'EXISTS', a, c).result, [0, 0]);
      const sha = f.command('SCRIPT', 'LOAD', 'return 1').result;
      f.eval('return 2', 0);
      f.eval('return "123456789"', 0);
      assert.deepEqual(f.command('SCRIPT', 'EXISTS', sha).result, [0]);
      assert.match(f.eval(' '.repeat(25), 0).error, /cache byte limit/);
    });

    it('refreshes the canonical EVALSHA entry even when execution fails', (t) => {
      const f = fixture(t, { maxCachedScripts: 2 });
      const a = f.command('SCRIPT', 'LOAD', 'error("stop")').result;
      const b = f.command('SCRIPT', 'LOAD', 'return 2').result;
      assert.match(f.command('EVALSHA', a.toUpperCase(), 0).error, /stop/);
      const c = f.command('SCRIPT', 'LOAD', 'return 3').result;
      assert.deepEqual(f.command('SCRIPT', 'EXISTS', a, b, c).result, [1, 0, 1]);
      f.command('SCRIPT', 'FLUSH');
      assert.match(f.command('EVALSHA', a, 0).error, /^NOSCRIPT/);
      assert.deepEqual(f.command('SCRIPT', 'EXISTS', a).result, [0]);
    });

    it('uses one time reference for key and hash field TTLs', (t) => {
      let now = 1000;
      const f = fixture(t, {}, { clock: () => now });
      f.engine.set('k', 'v');
      f.engine.pexpire('k', 10);
      f.engine.hset('h', 'f', 'v');
      f.command('HPEXPIRE', 'h', 10, 'FIELDS', 1, 'f');
      const get = f.engine.get.bind(f.engine);
      f.engine.get = (...args) => { now += 20; return get(...args); };
      assert.deepEqual(f.eval(`return {redis.call('GET','k'),redis.call('PTTL','k'),redis.call('HGET','h','f')}`, 0).result,
        [Buffer.from('v'), 10, Buffer.from('v')]);
      assert.equal(f.engine.get('k'), null);
      assert.equal(f.engine.hget('h', 'f'), null);
    });

    it('defers list consumers until success or error, then wakes all eligible waiters', (t) => {
      const f = fixture(t);
      const deliveries = [];
      for (let i = 0; i < 2; i++) f.engine._blockingManager.registerWaiter([Buffer.from('q')], 'BLPOP', 0, (v) => deliveries.push(v), i);
      assert.equal(f.eval(`redis.call('RPUSH','q','a','b'); return redis.call('LLEN','q')`, 0).result, 2);
      assert.deepEqual(deliveries.map((v) => v[1].toString()), ['a', 'b']);
      f.engine._blockingManager.registerWaiter([Buffer.from('q')], 'BLPOP', 0, (v) => deliveries.push(v), 3);
      assert.match(f.eval(`redis.call('RPUSH','q','c'); error('stop')`, 0).error, /stop/);
      assert.equal(deliveries[2][1].toString(), 'c');
    });

    it('owns a single server and closes idempotently', () => {
      const plugin = createScripting();
      const owner = {};
      plugin.attach(owner);
      plugin.attach(owner);
      assert.throws(() => plugin.attach({}), /another server/);
      plugin.close();
      plugin.close();
      assert.throws(() => plugin.attach(owner), /closed/);
      assert.throws(() => createScripting({ timeoutMs: 0 }), /positive/);
    });

  });
}

describe('Wasmoon runtime', () => {
  it('rejects modules that have not been initialized', () => {
    assert.throws(() => createWasmoonScripting({}), /initialized/);
  });

  it('reuses only trusted bootstrap bytecode across isolated executions', () => {
    const module = new Proxy(lua.module, {});
    const loads = [];
    let bytecode;
    const tracked = Object.assign(Object.create(lua), {
      module,
      luaL_loadbufferx(L, pointer, length, name, mode) {
        loads.push({ name, mode });
        if (name === '@resplite' && mode === 'b') {
          bytecode = Buffer.from(module.HEAPU8.subarray(pointer, pointer + length));
        }
        return lua.luaL_loadbufferx(L, pointer, length, name, mode);
      },
    });
    const execute = (code, value) => runLua(tracked, Buffer.from(code), [], [], DEFAULTS, () => Buffer.from(value));
    assert.equal(execute(`local v=redis.call('GET','k'); string.lower=nil; redis.call=nil; return v`, 'first').toString(), 'first');
    assert.equal(execute(`return string.lower(redis.call('GET','k'))`, 'SECOND').toString(), 'second');
    assert.deepEqual(loads.filter((l) => l.name === '@resplite').map((l) => l.mode), ['t', 'b']);
    assert.ok(bytecode.length > 0);
    assert.throws(() => execute(bytecode, 'unused'), /binary/);
    assert.equal(execute(`return redis.call('GET','k')`, 'third').toString(), 'third');
    assert.ok(loads.filter((l) => l.name === '@user_script').every((l) => l.mode === 't'));
  });

  it('releases state allocations and callback pointers after success, error and abort', () => {
    const allocations = new Set();
    const callbacks = new Set();
    const module = new Proxy(lua.module, {
      get(target, name) {
        if (name === '_malloc') return (size) => {
          const p = target._malloc(size);
          if (p) allocations.add(p);
          return p;
        };
        if (name === '_realloc') return (p, size) => {
          const next = target._realloc(p, size);
          if (next) { allocations.delete(p); allocations.add(next); }
          return next;
        };
        if (name === '_free') return (p) => { allocations.delete(p); target._free(p); };
        if (name === 'addFunction') return (...args) => {
          const p = target.addFunction(...args);
          callbacks.add(p);
          return p;
        };
        if (name === 'removeFunction') return (p) => { callbacks.delete(p); target.removeFunction(p); };
        return target[name];
      },
    });
    const tracked = Object.assign(Object.create(lua), { module });
    for (const code of ['return 1', 'return )', 'error("stop")', 'while true do end',
      'table.sort({2,1}, function() while true do end end)',
      'local a={} for i=1,100000 do a[i]=string.rep("x",1024) end']) {
      try { runLua(tracked, Buffer.from(code), [], [], { ...DEFAULTS, timeoutMs: 10, maxMemoryBytes: 65536 }, () => null); }
      catch (error) { assert.match(error.message, /^ERR/); }
      assert.equal(allocations.size, 0, code);
      assert.equal(callbacks.size, 0, code);
    }
  });
});

it('cuts protected infinite loops and memory exhaustion in an isolated process, then recovers', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {LuaFactory} from 'wasmoon';
    import {runLua} from './src/scripting/runtime.js';
    import {DEFAULTS} from './src/scripting/config.js';
    const lua = await new LuaFactory().getLuaModule();
    const config = {...DEFAULTS, timeoutMs:30, maxMemoryBytes:65536};
    for (const source of [
      'while true do end',
      'while true do pcall(function() while true do end end) end',
      'xpcall(function() while true do end end, function() while true do end end)',
      'table.sort({3,2,1},function() while true do pcall(function() while true do end end) end end)',
      'xpcall(function() error("fail") end, function() while true do pcall(function() while true do end end) end end)',
      'local a={} for i=1,100000 do a[i]=string.rep("x",1024) end',
      'while true do pcall(function() local a={} for i=1,100000 do a[i]=string.rep("x",1024) end end) end'
    ]) {
      assert.throws(() => runLua(lua,Buffer.from(source),[],[],config,()=>null), /timed out|memory/);
      assert.equal(runLua(lua,Buffer.from('return 42'),[],[],DEFAULTS,()=>null),42);
    }
    for (let i=0;i<100;i++) assert.equal(runLua(lua,Buffer.from('return 1'),[],[],DEFAULTS,()=>null),1);
  `], { cwd: new URL('../..', import.meta.url), encoding: 'utf8', timeout: 15000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr + child.stdout);
});
