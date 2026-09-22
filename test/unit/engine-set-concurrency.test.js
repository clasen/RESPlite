import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { openDb } from '../../src/storage/sqlite/db.js';
import { createEngine } from '../../src/engine/engine.js';
import { tmpDbPath } from '../helpers/tmp.js';

it('serializes SET NX and XX GET across independent SQLite connections', { timeout: 20000 }, async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const engine = createEngine({ db });
  const rounds = 30;
  engine.set('exchange', 'seed');
  for (let i = 0; i < rounds; i++) engine.set(`nx:${i}`, 'expired', { pxat: 1 });
  const workers = [];
  try {
    const ready = [];
    for (let id = 0; id < 4; id++) {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { openDb } = await import(workerData.dbModule);
          const { createEngine } = await import(workerData.engineModule);
          const { createCache } = await import(workerData.cacheModule);
          const db = openDb(workerData.dbPath);
          const engine = createEngine({ db, cache: createCache() });
          parentPort.once('message', () => {
            const results = [];
            try {
              for (let i = 0; i < workerData.rounds; i++) {
                const value = workerData.id + ':' + i;
                const won = engine.setnx('nx:' + i, value);
                const previous = engine.set('exchange', value, { xx: true, get: true }).previous.toString();
                results.push({ value, won, previous });
              }
              parentPort.postMessage(results);
            } finally { db.close(); parentPort.close(); }
          });
          parentPort.postMessage('ready');
        })();
      `, { eval: true, workerData: {
        id, rounds, dbPath,
        dbModule: new URL('../../src/storage/sqlite/db.js', import.meta.url).href,
        engineModule: new URL('../../src/engine/engine.js', import.meta.url).href,
        cacheModule: new URL('../../src/cache/cache.js', import.meta.url).href,
      } });
      workers.push(worker);
      ready.push(once(worker, 'message'));
    }
    await Promise.all(ready);
    const replies = workers.map((worker) => once(worker, 'message'));
    workers.forEach((worker) => worker.postMessage('start'));
    const results = (await Promise.all(replies)).map(([result]) => result);
    for (let i = 0; i < rounds; i++) {
      const winners = results.map((result) => result[i]).filter((result) => result.won);
      assert.equal(winners.length, 1);
      assert.equal(engine.get(`nx:${i}`).toString(), winners[0].value);
    }
    const flat = results.flat();
    const final = engine.get('exchange').toString();
    assert.deepEqual(flat.map((r) => r.previous).sort(), ['seed', ...flat.map((r) => r.value).filter((v) => v !== final)].sort());
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    db.close();
  }
});
