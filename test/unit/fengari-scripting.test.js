import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fengari from 'fengari';
import { createFengariScripting } from '../../src/scripting/index.js';
import { runFengari } from '../../src/scripting/fengari-runtime.js';
import { FENGARI_DEFAULTS } from '../../src/scripting/config.js';

const execute = (source, args = [], call = () => null, module = fengari) =>
  runFengari(module, Buffer.from(source), [], args, FENGARI_DEFAULTS, call);

it('preserves arbitrary bytes and RESP2 reply conversions with Fengari', () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.deepEqual(execute('return {ARGV[1],string.len(ARGV[1]),redis.call("GET","k")}', [bytes], () => bytes), [bytes, 256, bytes]);
  assert.deepEqual(execute(Buffer.concat([Buffer.from('return "'), Buffer.from([255]), Buffer.from('"')])), Buffer.from([255]));
  assert.deepEqual(execute('return {true,false,1.9,-1.9,{1,nil,3},redis.status_reply("á"),redis.error_reply("é")}'),
    [1, null, 1, -1, [1], { simple: 'á' }, { error: 'é' }]);
  assert.deepEqual(execute('return redis.call("PING")', [], () => ({ simple: 'á' })), { simple: 'á' });
  assert.deepEqual(execute('return redis.pcall("GET","k")', [], () => ({ error: 'ERR é' })), { error: 'ERR é' });
  assert.throws(() => execute('return redis.call("GET","k")', [], () => ({ error: 'ERR é' })), /ERR é/);
  assert.equal(execute('return'), null);
  assert.equal(execute('return 1,2'), 1);
  assert.throws(() => execute('local a={} a[1]=a return a'), /cyclic/);
  assert.throws(() => execute('return 1/0'), /safe integer/);
  assert.equal(execute('return 2147483647 + 1'), -2147483648);
  assert.equal(execute('return redis.call("GET","k")', [], () => 4294967296), 4294967296);
});

it('reuses trusted bootstrap bytecode without leaking state, callbacks or host access', () => {
  const modes = [];
  let bytecode;
  let closes = 0;
  const module = {
    ...fengari,
    lua: { ...fengari.lua, lua_close(L) { closes++; fengari.lua.lua_close(L); } },
    lauxlib: {
      ...fengari.lauxlib,
      luaL_loadbufferx(L, buffer, size, name, mode) {
        if (Buffer.from(name).toString() === '@resplite') {
          modes.push(Buffer.from(mode).toString());
          if (modes.at(-1) === 'b') bytecode = Buffer.from(buffer);
        }
        return fengari.lauxlib.luaL_loadbufferx(L, buffer, size, name, mode);
      },
    },
  };
  assert.equal(execute('string.lower=nil; custom=1; return redis.call("GET","k")', [], () => 1, module), 1);
  assert.deepEqual(execute('return {custom==nil,string.lower("ABC"),redis.call("GET","k")}', [], () => 2, module), [1, Buffer.from('abc'), 2]);
  assert.deepEqual(modes, ['t', 'b']);
  assert.throws(() => execute(bytecode, [], () => null, module), /binary/);
  assert.throws(() => execute('return )', [], () => null, module), /user_script/);
  assert.throws(() => execute('error("stop")', [], () => null, module), /stop/);
  assert.equal(closes, 5);
  for (const name of ['os', 'io', 'debug', 'require', 'package', 'load', 'loadfile', 'dofile', 'js', 'coroutine', 'setmetatable', '_G', 'string.dump']) {
    assert.equal(execute(`return ${name} == nil`), 1, name);
  }
});

it('rejects unsupported memory limits and invalid Fengari configuration', () => {
  assert.throws(() => createFengariScripting({}), /Fengari module/);
  assert.throws(() => createFengariScripting(fengari, { maxMemoryBytes: 65536 }), /does not support/);
  assert.throws(() => createFengariScripting(fengari, { timeoutMs: 0 }), /positive/);
  assert.throws(() => createFengariScripting(fengari, { unknown: 1 }), /Unknown/);
});

it('interrupts yieldable protected loops and recovers under an external watchdog', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fengari from 'fengari';
    import {runFengari} from './src/scripting/fengari-runtime.js';
    import {FENGARI_DEFAULTS} from './src/scripting/config.js';
    const run = (source) => runFengari(fengari,Buffer.from(source),[],[],{...FENGARI_DEFAULTS,timeoutMs:50},()=>null);
    for (const source of ['while true do end',
      'while true do pcall(function() while true do end end) end',
      'xpcall(function() while true do end end, function() return 1 end)',
      'table.sort({2,1}, function() while true do end end)']) {
      assert.throws(() => run(source), /timed out/);
      assert.equal(run('return 42'),42);
    }
  `], { cwd: new URL('../..', import.meta.url), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr + child.stdout);
});
