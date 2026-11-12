/**
 * Delta apply: reimport or delete keys from dirty registry (SPEC_F §F.8).
 */

import { openDb } from '../storage/sqlite/db.ts';
import { createKeysStorage } from '../storage/sqlite/keys.ts';
import { createStringsStorage } from '../storage/sqlite/strings.ts';
import { createHashesStorage } from '../storage/sqlite/hashes.ts';
import { createSetsStorage } from '../storage/sqlite/sets.ts';
import { createListsStorage } from '../storage/sqlite/lists.ts';
import { createZsetsStorage } from '../storage/sqlite/zsets.ts';
import { getRun, getDirtyBatch, markDirtyState, logError, RUN_STATUS } from './registry.ts';
import type { MigrationRun } from './registry.ts';
import { importKeyFromRedis } from './import-one.ts';
import type { ImportKeyResult } from './import-one.ts';
import type { MigrationRedisClient } from './redis-client.ts';

/** Run row plus dirty-apply throughput, pending counts and ETA, passed to `onProgress`. */
export interface DirtyProgress extends MigrationRun {
  dirty_elapsed_seconds: number;
  dirty_keys_per_second: number;
  dirty_keys_processed: number;
  dirty_keys_fetched: number;
  dirty_reconciled_total: number;
  dirty_pending: number;
  dirty_pending_dirty: number;
  dirty_pending_deleted: number;
  dirty_eta_seconds: number | null;
}

export interface ApplyDirtyOptions {
  /** PRAGMA preset. Default `'default'`. */
  pragmaTemplate?: string;
  /** Dirty keys fetched per batch. Default 200. */
  batch_keys?: number;
  /** Max requests/s; 0 = no limit. Default 0. */
  max_rps?: number;
  /** Concurrent key imports. Default 1. */
  concurrency?: number;
  /** Minimum interval between progress callbacks. Default 2000. */
  progress_interval_ms?: number;
  /** Called after each batch with the current run row. */
  onProgress?: (run: DirtyProgress) => void | Promise<void>;
}

type DirtyKeyOutcome = { keyBuf: Buffer; keyName: string } & (
  | { state: 'deleted' }
  | { state: 'imported'; outcome: ImportKeyResult }
  | { state: 'exception'; error: unknown }
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDirtyProgressPayload(
  run: MigrationRun,
  startedAtMs: number,
  totalProcessed: number,
  totalFetched: number,
  pendingDirty: number,
  pendingDeleted: number
): DirtyProgress;
function buildDirtyProgressPayload(
  run: MigrationRun | undefined,
  startedAtMs: number,
  totalProcessed: number,
  totalFetched: number,
  pendingDirty: number,
  pendingDeleted: number
): DirtyProgress | null;
function buildDirtyProgressPayload(
  run: MigrationRun | undefined,
  startedAtMs: number,
  totalProcessed: number,
  totalFetched: number,
  pendingDirty: number,
  pendingDeleted: number
): DirtyProgress | null {
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
 */
export async function runApplyDirty(
  redisClient: MigrationRedisClient,
  dbPath: string,
  runId: string,
  options: ApplyDirtyOptions = {}
): Promise<MigrationRun | undefined> {
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

  function emitProgress(force: boolean = false, pendingDirty: number = 0, pendingDeleted: number = 0): void {
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
        chunk.map(async ({ key: keyBuf }): Promise<DirtyKeyOutcome> => {
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
            logError(
              db,
              runId,
              'dirty_apply',
              result.error instanceof Error ? result.error.message : String(result.error),
              result.keyBuf
            );
            markDirtyState(db, runId, result.keyBuf, 'error');
          }
        } catch (err) {
          logError(db, runId, 'dirty_apply', err instanceof Error ? err.message : String(err), result.keyBuf);
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
          logError(db, runId, 'dirty_apply', err instanceof Error ? err.message : String(err), keyBuf);
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
