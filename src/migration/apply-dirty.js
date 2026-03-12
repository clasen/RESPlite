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

function buildDirtyProgressPayload(run, startedAtMs, totalProcessed, totalFetched, pendingDirty, pendingDeleted) {
  if (!run) return null;
  const elapsedSec = Math.max(0.001, (Date.now() - startedAtMs) / 1000);
  const keysPerSec = totalProcessed / elapsedSec;
  const pendingTotal = pendingDirty + pendingDeleted;
  const etaSeconds = keysPerSec > 0 ? Math.ceil(pendingTotal / keysPerSec) : null;
  const applied = Number(run.dirty_keys_applied || 0);
  const deleted = Number(run.dirty_keys_deleted || 0);
  const reconciled = applied + deleted;

  return {
    ...run,
    dirty_elapsed_seconds: elapsedSec,
    dirty_keys_per_second: keysPerSec,
    dirty_keys_processed: totalProcessed,
    dirty_keys_fetched: totalFetched,
    dirty_reconciled_total: reconciled,
    dirty_pending: pendingTotal,
    dirty_pending_dirty: pendingDirty,
    dirty_pending_deleted: pendingDeleted,
    dirty_eta_seconds: etaSeconds,
  };
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
 * @param {number} [options.concurrency=1]
 * @param {number} [options.progress_interval_ms=2000]
 * @param {(run: object) => void | Promise<void>} [options.onProgress] - Called after each batch with the current run row.
 */
export async function runApplyDirty(redisClient, dbPath, runId, options = {}) {
  const {
    pragmaTemplate = 'default',
    batch_keys = 200,
    max_rps = 0,
    concurrency = 1,
    progress_interval_ms = 2000,
    onProgress,
  } = options;

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
  const workerCount = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  let nextAllowedAt = 0;
  const startedAtMs = Date.now();
  let totalProcessed = 0;
  let totalFetched = 0;
  let lastProgressAt = 0;

  async function awaitRateLimit() {
    if (minIntervalMs <= 0) return;
    const now = Date.now();
    const scheduled = Math.max(now, nextAllowedAt);
    nextAllowedAt = scheduled + minIntervalMs;
    if (scheduled > now) {
      await sleep(scheduled - now);
    }
  }

  function emitProgress(force = false, pendingDirty = 0, pendingDeleted = 0) {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < progress_interval_ms) return;
    const current = getRun(db, runId);
    lastProgressAt = now;
    if (current) {
      const payload = buildDirtyProgressPayload(
        current,
        startedAtMs,
        totalProcessed,
        totalFetched,
        pendingDirty,
        pendingDeleted
      );
      Promise.resolve(onProgress(payload)).catch(() => {});
    }
  }

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

    totalFetched += dirtyBatch.length + deletedBatch.length;
    let aborted = false;

    // ── Re-import (or remove) keys that changed while bulk was running ──
    for (let i = 0; i < dirtyBatch.length; i += workerCount) {
      r = getRun(db, runId);
      if (r && r.status === RUN_STATUS.ABORTED) {
        aborted = true;
        break;
      }
      while (r && r.status === RUN_STATUS.PAUSED) {
        await sleep(2000);
        r = getRun(db, runId);
      }
      if (r && r.status === RUN_STATUS.ABORTED) {
        aborted = true;
        break;
      }

      const chunk = dirtyBatch.slice(i, i + workerCount);
      const results = await Promise.all(
        chunk.map(async ({ key: keyBuf }) => {
          const keyName = keyBuf.toString('utf8');
          try {
            await awaitRateLimit();
            const type = (await redisClient.type(keyName)).toLowerCase();
            if (type === 'none' || !type) {
              return { keyBuf, keyName, state: 'deleted' };
            }
            const outcome = await importKeyFromRedis(redisClient, keyName, storages, {});
            return { keyBuf, keyName, state: 'imported', outcome };
          } catch (err) {
            return { keyBuf, keyName, state: 'exception', error: err };
          }
        })
      );

      for (const result of results) {
        try {
          if (result.state === 'deleted') {
            keys.delete(result.keyBuf);
            markDirtyState(db, runId, result.keyBuf, 'deleted');
          } else if (result.state === 'imported') {
            if (result.outcome.ok) {
              markDirtyState(db, runId, result.keyBuf, 'applied');
            } else if (result.outcome.skipped) {
              markDirtyState(db, runId, result.keyBuf, 'skipped');
            } else {
              logError(
                db,
                runId,
                'dirty_apply',
                result.outcome.error ? 'Import failed' : 'Skipped',
                result.keyName
              );
              markDirtyState(db, runId, result.keyBuf, 'error');
            }
          } else {
            logError(db, runId, 'dirty_apply', result.error.message, result.keyBuf);
            markDirtyState(db, runId, result.keyBuf, 'error');
          }
        } catch (err) {
          logError(db, runId, 'dirty_apply', err.message, result.keyBuf);
          markDirtyState(db, runId, result.keyBuf, 'error');
        } finally {
          totalProcessed++;
        }
      }

      emitProgress(false, Math.max(0, dirtyBatch.length - (i + chunk.length)), deletedBatch.length);
    }

    if (aborted) {
      emitProgress(true, dirtyBatch.length, deletedBatch.length);
      break;
    }

    // ── Apply deletions recorded by the tracker (del / expired events) ──
    // The tracker already determined these keys are gone; delete from destination.
    // Marked as 'deleted' in the run counter; state changed away from 'deleted'
    // so the next getDirtyBatch call won't return them again (avoiding infinite loop).
    for (let i = 0; i < deletedBatch.length; i += workerCount) {
      r = getRun(db, runId);
      if (r && r.status === RUN_STATUS.ABORTED) {
        aborted = true;
        break;
      }
      while (r && r.status === RUN_STATUS.PAUSED) {
        await sleep(2000);
        r = getRun(db, runId);
      }
      if (r && r.status === RUN_STATUS.ABORTED) {
        aborted = true;
        break;
      }

      const chunk = deletedBatch.slice(i, i + workerCount);
      for (const { key: keyBuf } of chunk) {
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
        } finally {
          totalProcessed++;
        }
      }
      emitProgress(false, 0, Math.max(0, deletedBatch.length - (i + chunk.length)));
      if (aborted) break;
    }

    if (aborted) {
      emitProgress(true, dirtyBatch.length, deletedBatch.length);
      break;
    }

    const pendingDirty = db.prepare(
      `SELECT COUNT(*) as n FROM migration_dirty_keys WHERE run_id = ? AND state = 'dirty'`
    ).get(runId).n;
    const pendingDeleted = db.prepare(
      `SELECT COUNT(*) as n FROM migration_dirty_keys WHERE run_id = ? AND state = 'deleted'`
    ).get(runId).n;
    emitProgress(true, pendingDirty, pendingDeleted);
  }

  const finalPendingDirty = db.prepare(
    `SELECT COUNT(*) as n FROM migration_dirty_keys WHERE run_id = ? AND state = 'dirty'`
  ).get(runId).n;
  const finalPendingDeleted = db.prepare(
    `SELECT COUNT(*) as n FROM migration_dirty_keys WHERE run_id = ? AND state = 'deleted'`
  ).get(runId).n;
  emitProgress(true, finalPendingDirty, finalPendingDeleted);
  return getRun(db, runId);
}
