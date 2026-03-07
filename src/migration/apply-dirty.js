/**
 * Delta apply: reimport or delete keys from dirty registry (SPEC_F §F.8).
 */

import { openDb } from '../storage/sqlite/db.js';
import { createKeysStorage } from '../storage/sqlite/keys.js';
import { createStringsStorage } from '../storage/sqlite/strings.js';
import { createHashesStorage } from '../storage/sqlite/hashes.js';
import { createSetsStorage } from '../storage/sqlite/sets.js';
import { createListsStorage } from '../storage/sqlite/lists.js';
import { createZsetsStorage } from '../storage/sqlite/zsets.js';
import { getRun, getDirtyBatch, markDirtyState, logError, RUN_STATUS } from './registry.js';
import { importKeyFromRedis } from './import-one.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply dirty keys: for each key in registry with state=dirty, reimport from Redis or delete in destination.
 * @param {import('redis').RedisClientType} redisClient
 * @param {string} dbPath
 * @param {string} runId
 * @param {object} options
 * @param {string} [options.pragmaTemplate='default']
 * @param {number} [options.batch_keys=200]
 * @param {number} [options.max_rps=0]
 * @param {(run: object) => void | Promise<void>} [options.onProgress] - Called after each batch with the current run row.
 */
export async function runApplyDirty(redisClient, dbPath, runId, options = {}) {
  const { pragmaTemplate = 'default', batch_keys = 200, max_rps = 0, onProgress } = options;

  const db = openDb(dbPath, { pragmaTemplate });
  const run = getRun(db, runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const keys = createKeysStorage(db);
  const strings = createStringsStorage(db, keys);
  const hashes = createHashesStorage(db, keys);
  const sets = createSetsStorage(db, keys);
  const lists = createListsStorage(db, keys);
  const zsets = createZsetsStorage(db, keys);
  const storages = { keys, strings, hashes, sets, lists, zsets };

  const minIntervalMs = max_rps > 0 ? 1000 / max_rps : 0;
  let lastKeyTime = 0;

  for (;;) {
    let r = getRun(db, runId);
    if (r && r.status === RUN_STATUS.ABORTED) break;
    while (r && r.status === RUN_STATUS.PAUSED) {
      await sleep(2000);
      r = getRun(db, runId);
    }

    const dirtyBatch   = getDirtyBatch(db, runId, 'dirty',   batch_keys);
    const deletedBatch = getDirtyBatch(db, runId, 'deleted', batch_keys);
    if (dirtyBatch.length === 0 && deletedBatch.length === 0) break;

    const batchSize = dirtyBatch.length + deletedBatch.length;

    // ── Re-import (or remove) keys that changed while bulk was running ──
    for (const { key: keyBuf } of dirtyBatch) {
      r = getRun(db, runId);
      if (r && r.status === RUN_STATUS.ABORTED) break;
      while (r && r.status === RUN_STATUS.PAUSED) {
        await sleep(2000);
        r = getRun(db, runId);
      }

      if (minIntervalMs > 0) {
        const elapsed = Date.now() - lastKeyTime;
        if (elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed);
        lastKeyTime = Date.now();
      }

      const keyName = keyBuf.toString('utf8');
      try {
        const type = (await redisClient.type(keyName)).toLowerCase();
        if (type === 'none' || !type) {
          keys.delete(keyBuf);
          markDirtyState(db, runId, keyBuf, 'deleted');
        } else {
          const outcome = await importKeyFromRedis(redisClient, keyName, storages, {});
          if (outcome.ok) {
            markDirtyState(db, runId, keyBuf, 'applied');
          } else if (outcome.skipped) {
            markDirtyState(db, runId, keyBuf, 'skipped');
          } else {
            logError(db, runId, 'dirty_apply', outcome.error ? 'Import failed' : 'Skipped', keyName);
            markDirtyState(db, runId, keyBuf, 'error');
          }
        }
      } catch (err) {
        logError(db, runId, 'dirty_apply', err.message, keyBuf);
        markDirtyState(db, runId, keyBuf, 'error');
      }
    }

    // ── Apply deletions recorded by the tracker (del / expired events) ──
    // The tracker already determined these keys are gone; delete from destination.
    // Marked as 'deleted' in the run counter; state changed away from 'deleted'
    // so the next getDirtyBatch call won't return them again (avoiding infinite loop).
    for (const { key: keyBuf } of deletedBatch) {
      r = getRun(db, runId);
      if (r && r.status === RUN_STATUS.ABORTED) break;
      while (r && r.status === RUN_STATUS.PAUSED) {
        await sleep(2000);
        r = getRun(db, runId);
      }

      try {
        keys.delete(keyBuf);
        // Increment dirty_keys_deleted counter and transition state out of 'deleted'
        // so this key is not re-processed in the next batch iteration.
        const now = Date.now();
        db.prepare(
          `UPDATE migration_dirty_keys SET state = 'applied', last_seen_at = ? WHERE run_id = ? AND key = ?`
        ).run(now, runId, keyBuf);
        db.prepare(
          `UPDATE migration_runs SET dirty_keys_deleted = dirty_keys_deleted + 1, updated_at = ? WHERE run_id = ?`
        ).run(now, runId);
      } catch (err) {
        logError(db, runId, 'dirty_apply', err.message, keyBuf);
        markDirtyState(db, runId, keyBuf, 'error');
      }
    }
    if (batchSize > 0 && onProgress) {
      const run = getRun(db, runId);
      if (run) Promise.resolve(onProgress(run)).catch(() => {});
    }
  }

  return getRun(db, runId);
}
