/**
 * Bulk import from Redis with checkpointing, resume, and throttling (SPEC_F §F.7).
 */

import { openDb } from '../storage/sqlite/db.js';
import { createKeysStorage } from '../storage/sqlite/keys.js';
import { createStringsStorage } from '../storage/sqlite/strings.js';
import { createHashesStorage } from '../storage/sqlite/hashes.js';
import { createSetsStorage } from '../storage/sqlite/sets.js';
import { createListsStorage } from '../storage/sqlite/lists.js';
import { createZsetsStorage } from '../storage/sqlite/zsets.js';
import {
  createRun,
  getRun,
  updateBulkProgress,
  setRunStatus,
  logError,
  RUN_STATUS,
} from './registry.js';
import { importKeyFromRedis } from './import-one.js';

function parseScanResult(result) {
  if (Array.isArray(result)) {
    return { cursor: parseInt(result[0], 10), keys: result[1] || [] };
  }
  if (result && typeof result === 'object') {
    const cursor = typeof result.cursor === 'number' ? result.cursor : parseInt(String(result.cursor), 10);
    const keys = result.keys || [];
    return { cursor, keys };
  }
  return { cursor: 0, keys: [] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run bulk import: SCAN keys from Redis, import into RespLite DB with checkpointing.
 * On SIGINT/SIGTERM, checkpoint progress, set run status to ABORTED, close DB and rethrow.
 * DB is always closed in a finally block (graceful shutdown when process is interrupted).
 *
 * @param {import('redis').RedisClientType} redisClient
 * @param {string} dbPath
 * @param {string} runId
 * @param {object} options
 * @param {string} options.sourceUri
 * @param {string} [options.pragmaTemplate='default']
 * @param {number} [options.scan_count=1000]
 * @param {number} [options.max_rps=0] - 0 = no limit
 * @param {number} [options.batch_keys=200]
 * @param {number} [options.batch_bytes=64*1024*1024] - 64MB
 * @param {number} [options.checkpoint_interval_sec=30]
 * @param {boolean} [options.resume=true] - true: start from 0 or continue from checkpoint; false: always start from 0
 * @param {function(run): void} [options.onProgress] - called after checkpoint with run row
 */
export async function runBulkImport(redisClient, dbPath, runId, options = {}) {
  const {
    sourceUri,
    pragmaTemplate = 'default',
    scan_count = 1000,
    max_rps = 0,
    batch_keys = 200,
    batch_bytes = 64 * 1024 * 1024,
    checkpoint_interval_sec = 30,
    resume = true,
    onProgress,
  } = options;

  const db = openDb(dbPath, { pragmaTemplate });
  let abortRequested = false;
  const onSignal = () => {
    abortRequested = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const keys = createKeysStorage(db);
    const strings = createStringsStorage(db, keys);
    const hashes = createHashesStorage(db, keys);
    const sets = createSetsStorage(db, keys);
    const lists = createListsStorage(db, keys);
    const zsets = createZsetsStorage(db, keys);
    const storages = { keys, strings, hashes, sets, lists, zsets };

    createRun(db, runId, sourceUri, { scan_count_hint: scan_count });
    let run = getRun(db, runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    let cursor = resume && run.scan_cursor !== undefined ? parseInt(String(run.scan_cursor), 10) : 0;
    let scanned_keys = resume ? (run.scanned_keys || 0) : 0;
    let migrated_keys = resume ? (run.migrated_keys || 0) : 0;
    let skipped_keys = resume ? (run.skipped_keys || 0) : 0;
    let error_keys = resume ? (run.error_keys || 0) : 0;
    let migrated_bytes = resume ? (run.migrated_bytes || 0) : 0;

    if (!resume) {
      updateBulkProgress(db, runId, { scan_cursor: String(cursor), scanned_keys, migrated_keys, skipped_keys, error_keys, migrated_bytes });
    }

    let lastCheckpointTime = Date.now();
    let batchScanned = 0;
    let batchBytes = 0;
    const minIntervalMs = max_rps > 0 ? 1000 / max_rps : 0;
    let lastKeyTime = 0;

    outer: do {
      run = getRun(db, runId);
      if (run && run.status === RUN_STATUS.ABORTED) break;
      if (abortRequested) break;
      while (run && run.status === RUN_STATUS.PAUSED) {
        await sleep(2000);
        run = getRun(db, runId);
      }

      const result = await redisClient.scan(cursor, { COUNT: scan_count });
      const parsed = parseScanResult(result);
      cursor = parsed.cursor;
      const keyList = parsed.keys || [];

      for (const keyName of keyList) {
        if (abortRequested) break outer;
        run = getRun(db, runId);
        if (run && run.status === RUN_STATUS.ABORTED) break outer;
        while (run && run.status === RUN_STATUS.PAUSED) {
          await sleep(2000);
          run = getRun(db, runId);
        }

        scanned_keys++;
        if (minIntervalMs > 0) {
          const elapsed = Date.now() - lastKeyTime;
          if (elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed);
          lastKeyTime = Date.now();
        }

        const now = Date.now();
        const outcome = await importKeyFromRedis(redisClient, keyName, storages, { now });
        if (outcome.ok) {
          migrated_keys++;
          migrated_bytes += outcome.bytes || 0;
          batchScanned++;
          batchBytes += outcome.bytes || 0;
        } else if (outcome.skipped) {
          skipped_keys++;
        } else {
          error_keys++;
          logError(db, runId, 'bulk', outcome.error ? 'Import failed' : 'Skipped', keyName);
        }

        const now2 = Date.now();
        const shouldCheckpoint =
          batchScanned >= batch_keys ||
          batchBytes >= batch_bytes ||
          now2 - lastCheckpointTime >= checkpoint_interval_sec * 1000;
        if (shouldCheckpoint) {
          updateBulkProgress(db, runId, {
            scan_cursor: String(cursor),
            scanned_keys,
            migrated_keys,
            skipped_keys,
            error_keys,
            migrated_bytes,
          });
          lastCheckpointTime = now2;
          batchScanned = 0;
          batchBytes = 0;
          run = getRun(db, runId);
          if (onProgress && run) onProgress(run);
        }
      }
    } while (cursor !== 0);

    if (abortRequested) {
      updateBulkProgress(db, runId, {
        scan_cursor: String(cursor),
        scanned_keys,
        migrated_keys,
        skipped_keys,
        error_keys,
        migrated_bytes,
      });
      setRunStatus(db, runId, RUN_STATUS.ABORTED);
      run = getRun(db, runId);
      if (onProgress && run) onProgress(run);
      const err = new Error('Bulk import interrupted by signal (SIGINT/SIGTERM)');
      err.code = 'BULK_ABORTED';
      throw err;
    }

    updateBulkProgress(db, runId, {
      scan_cursor: '0',
      scanned_keys,
      migrated_keys,
      skipped_keys,
      error_keys,
      migrated_bytes,
    });
    setRunStatus(db, runId, RUN_STATUS.COMPLETED);
    return getRun(db, runId);
  } catch (err) {
    if (err.code !== 'BULK_ABORTED') {
      setRunStatus(db, runId, RUN_STATUS.FAILED);
      updateBulkProgress(db, runId, { last_error: err.message });
      logError(db, runId, 'bulk', err.message, null);
    }
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    db.close();
  }
}
