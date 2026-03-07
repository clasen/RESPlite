/**
 * Programmatic migration API (SPEC_F §F.9).
 *
 * Usage:
 *   import { createMigration } from 'resplite/migration';
 *
 *   const m = createMigration({
 *     from: 'redis://127.0.0.1:6379',
 *     to:   './data.db',
 *     runId: 'my-migration-1',
 *   });
 *
 *   const info   = await m.preflight();
 *   await m.bulk({ onProgress: console.log });
 *   const status = m.status();
 *   await m.applyDirty({ onProgress: console.log });
 *   const result = await m.verify();
 *   await m.close();
 */

import { createClient } from 'redis';
import { openDb } from '../storage/sqlite/db.js';
import { runPreflight, readKeyspaceEvents, setKeyspaceEvents } from './preflight.js';
import { runBulkImport } from './bulk.js';
import { runApplyDirty } from './apply-dirty.js';
import { runVerify } from './verify.js';
import { runMigrateSearch } from './migrate-search.js';
import { getRun, getDirtyCounts } from './registry.js';
import { startDirtyTracker as startDirtyTrackerProcess } from './tracker.js';

/**
 * @typedef {object} MigrationOptions
 * @property {string} [from='redis://127.0.0.1:6379'] - Source Redis URL.
 * @property {string} to                              - Destination SQLite DB path.
 * @property {string} [runId]                         - Unique run identifier (required for bulk/status/applyDirty).
 * @property {string} [pragmaTemplate='default']      - PRAGMA preset.
 * @property {number} [scanCount=1000]
 * @property {number} [maxRps=0]                      - Max requests/s (0 = unlimited).
 * @property {number} [batchKeys=200]
 * @property {number} [batchBytes=67108864]           - 64 MB default.
 * @property {string} [configCommand='CONFIG']        - Redis CONFIG command name. Override if renamed for security.
 */

/**
 * Create a migration controller bound to a source Redis and destination DB.
 *
 * @param {MigrationOptions} options
 * @returns {{
 *   preflight(): Promise<object>,
 *   enableKeyspaceNotifications(opts?: { value?: string, merge?: boolean }): Promise<{ ok: boolean, previous: string|null, applied: string, error?: string }>,
 *   startDirtyTracker(opts?: { pragmaTemplate?: string, onProgress?: function }): Promise<{ running: true }>,
 *   stopDirtyTracker(): Promise<{ running: false }>,
 *   bulk(opts?: { resume?: boolean, onProgress?: function }): Promise<object>,
 *   status(): { run: object, dirty: object } | null,
 *   applyDirty(opts?: { batchKeys?: number, maxRps?: number, onProgress?: function }): Promise<object>,
 *   verify(opts?: { samplePct?: number, maxSample?: number }): Promise<object>,
 *   migrateSearch(opts?: { onlyIndices?: string[], scanCount?: number, maxRps?: number, batchDocs?: number, maxSuggestions?: number, skipExisting?: boolean, withSuggestions?: boolean, onProgress?: function }): Promise<object>,
 *   close(): Promise<void>,
 * }}
 */
export function createMigration({
  from = 'redis://127.0.0.1:6379',
  to,
  runId,
  pragmaTemplate = 'default',
  scanCount = 1000,
  maxRps = 0,
  batchKeys = 200,
  batchBytes = 64 * 1024 * 1024,
  configCommand = 'CONFIG',
} = {}) {
  if (!to) throw new Error('createMigration: "to" (db path) is required');

  let _client = null;
  let _tracker = null;

  async function getClient() {
    if (_client) return _client;
    _client = createClient({ url: from });
    _client.on('error', (err) => {
      /* non-fatal connection errors; callers surface them on next await */
      void err;
    });
    await _client.connect();
    return _client;
  }

  function requireRunId() {
    if (!runId) throw new Error('createMigration: "runId" is required for this operation');
    return runId;
  }

  return {
    /**
     * Step 0 — Preflight: inspect the source Redis instance.
     * Returns key count estimate, type distribution, keyspace-events config,
     * `configCommandAvailable` (false when CONFIG is renamed/disabled),
     * and recommended import parameters.
     */
    async preflight() {
      const client = await getClient();
      return runPreflight(client, { configCommand });
    },

    /**
     * Enable keyspace notifications on the source Redis (required for the dirty-key tracker).
     * Reads the current value and merges the requested flags so existing flags are preserved.
     * If the CONFIG command has been renamed, pass `configCommand` to `createMigration`.
     *
     * @param {{ value?: string, merge?: boolean }} [opts]
     *   - `value`  Flags to apply. Defaults to `'KEA'` (keyevent + keyspace + all event types).
     *   - `merge`  If true (default), merges flags into the existing value instead of overwriting.
     * @returns {Promise<{ ok: boolean, previous: string|null, applied: string, error?: string }>}
     */
    async enableKeyspaceNotifications({ value = 'KEA', merge = true } = {}) {
      const client = await getClient();
      return setKeyspaceEvents(client, value, { configCommand, merge });
    },

    /**
     * Start dirty-key tracking in-process for this migration controller.
     * Use this to run the full minimal-downtime flow in one Node script.
     *
     * @param {{
     *   pragmaTemplate?: string,
     *   onProgress?: (progress: { runId: string, key: string, event: string, totalEvents: number, at: string }) => void | Promise<void>
     * }} [opts]
     */
    async startDirtyTracker({ pragmaTemplate: pt = pragmaTemplate, onProgress } = {}) {
      if (_tracker) return { running: true };
      const id = requireRunId();
      _tracker = await startDirtyTrackerProcess({
        from,
        to,
        runId: id,
        pragmaTemplate: pt,
        configCommand,
        onProgress,
      });
      return { running: true };
    },

    /**
     * Stop in-process dirty-key tracking started by `startDirtyTracker`.
     * Safe to call even if tracking is not running.
     */
    async stopDirtyTracker() {
      if (_tracker) {
        await _tracker.stop();
        _tracker = null;
      }
      return { running: false };
    },

    /**
     * Step 1 — Bulk import: SCAN all keys from Redis into the destination DB.
     * Resume is on by default: first run starts from 0, later runs continue from checkpoint.
     *
     * @param {{ resume?: boolean, onProgress?: (run: object) => void }} [opts] - resume (default true): start or continue automatically
     */
    async bulk({ resume = true, onProgress } = {}) {
      const id = requireRunId();
      const client = await getClient();
      return runBulkImport(client, to, id, {
        sourceUri: from,
        pragmaTemplate,
        scan_count: scanCount,
        max_rps: maxRps,
        batch_keys: batchKeys,
        batch_bytes: batchBytes,
        resume,
        onProgress,
      });
    },

    /**
     * Step 2 — Status: read run metadata and dirty-key counts from the DB.
     * Synchronous — no Redis connection needed.
     *
     * @returns {{ run: object, dirty: object } | null}
     */
    status() {
      const id = requireRunId();
      const db = openDb(to, { pragmaTemplate });
      const run = getRun(db, id);
      if (!run) return null;
      const dirty = getDirtyCounts(db, id);
      return { run, dirty };
    },

    /**
     * Step 3 — Apply dirty: reconcile keys that changed in Redis during bulk import.
     *
     * @param {{ batchKeys?: number, maxRps?: number, onProgress?: (run: object) => void }} [opts]
     */
    async applyDirty({ batchKeys: bk = batchKeys, maxRps: rps = maxRps, onProgress } = {}) {
      const id = requireRunId();
      const client = await getClient();
      return runApplyDirty(client, to, id, {
        pragmaTemplate,
        batch_keys: bk,
        max_rps: rps,
        onProgress,
      });
    },

    /**
     * Step 4 — Verify: sample keys from Redis and compare with the destination DB.
     *
     * @param {{ samplePct?: number, maxSample?: number }} [opts]
     * @returns {Promise<{ sampled: number, matched: number, mismatches: Array<{ key: string, reason: string }> }>}
     */
    async verify({ samplePct = 0.5, maxSample = 10000 } = {}) {
      const client = await getClient();
      return runVerify(client, to, { pragmaTemplate, samplePct, maxSample });
    },

    /**
     * Step 5 — Migrate search indices: copy RediSearch index schemas and documents
     * into RespLite FT.* tables.
     *
     * Requires RediSearch (Redis Stack or redis/search module) on the source.
     * Only HASH-based indices with TEXT/TAG/NUMERIC fields are supported.
     * TAG and NUMERIC fields are mapped to TEXT.
     *
     * @param {{
     *   onlyIndices?: string[],
     *   scanCount?: number,
     *   maxRps?: number,
     *   batchDocs?: number,
     *   maxSuggestions?: number,
     *   skipExisting?: boolean,
     *   withSuggestions?: boolean,
     *   onProgress?: (result: object) => void
     * }} [opts]
     * @returns {Promise<{ indices: object[], aborted: boolean }>}
     */
    async migrateSearch(opts = {}) {
      const client = await getClient();
      return runMigrateSearch(client, to, {
        pragmaTemplate,
        maxRps,
        ...opts,
      });
    },

    /**
     * Disconnect from Redis. Call when done with all migration operations.
     */
    async close() {
      if (_tracker) {
        await _tracker.stop().catch(() => {});
        _tracker = null;
      }
      if (_client) {
        await _client.quit().catch(() => {});
        _client = null;
      }
    },
  };
}

export { runPreflight, readKeyspaceEvents, setKeyspaceEvents, runBulkImport, runApplyDirty, runVerify, runMigrateSearch };
export { startDirtyTracker } from './tracker.js';
export { getRun, getDirtyCounts, createRun, setRunStatus, logError } from './registry.js';
