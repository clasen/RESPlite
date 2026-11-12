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
import { openDb } from '../storage/sqlite/db.ts';
import { runPreflight, readKeyspaceEvents, setKeyspaceEvents } from './preflight.ts';
import type { PreflightResult, SetKeyspaceEventsResult } from './preflight.ts';
import { runBulkImport } from './bulk.ts';
import type { BulkProgress } from './bulk.ts';
import { runApplyDirty } from './apply-dirty.ts';
import type { DirtyProgress } from './apply-dirty.ts';
import { runVerify } from './verify.ts';
import type { VerifyResult } from './verify.ts';
import { runMigrateSearch } from './migrate-search.ts';
import type { MigrateSearchOptions, MigrateSearchResult } from './migrate-search.ts';
import { getRun, getDirtyCounts } from './registry.ts';
import type { DirtyCounts, MigrationRun } from './registry.ts';
import { startDirtyTracker as startDirtyTrackerProcess } from './tracker.ts';
import type { DirtyTracker, DirtyTrackerProgress } from './tracker.ts';

export interface MigrationOptions {
  /** Source Redis URL. Default `'redis://127.0.0.1:6379'`. */
  from?: string;
  /** Destination SQLite DB path. */
  to: string;
  /** Unique run identifier (required for bulk/status/applyDirty). */
  runId?: string;
  /** PRAGMA preset. Default `'default'`. */
  pragmaTemplate?: string;
  /** Default 1000. */
  scanCount?: number;
  /** Max requests/s (0 = unlimited). Default 0. */
  maxRps?: number;
  /** Concurrent imports during bulk/apply-dirty migration. Default 1. */
  concurrency?: number;
  /** Optional total-keys estimate for ETA/progress in onProgress. Default 0. */
  estimatedTotalKeys?: number;
  /** Default 200. */
  batchKeys?: number;
  /** 64 MB default. */
  batchBytes?: number;
  /** Redis CONFIG command name. Override if renamed for security. Default `'CONFIG'`. */
  configCommand?: string;
}

export interface EnableKeyspaceNotificationsOptions {
  /** Flags to apply. Defaults to `'KEA'` (keyevent + keyspace + all event types). */
  value?: string;
  /** If true (default), merges flags into the existing value instead of overwriting. */
  merge?: boolean;
}

export interface ControllerDirtyTrackerOptions {
  pragmaTemplate?: string;
  onProgress?: (progress: DirtyTrackerProgress) => void | Promise<void>;
}

export interface ControllerBulkOptions {
  /** Start or continue automatically. Default true. */
  resume?: boolean;
  /** Concurrent key imports. Defaults to the createMigration option. */
  concurrency?: number;
  /** Used to compute ETA/progress fields in onProgress. */
  estimatedTotalKeys?: number;
  onProgress?: (run: BulkProgress) => void;
}

export interface ControllerApplyDirtyOptions {
  batchKeys?: number;
  maxRps?: number;
  concurrency?: number;
  progressIntervalMs?: number;
  onProgress?: (run: DirtyProgress) => void | Promise<void>;
}

export interface ControllerVerifyOptions {
  samplePct?: number;
  maxSample?: number;
}

export type ControllerMigrateSearchOptions = Omit<MigrateSearchOptions, 'pragmaTemplate'>;

export interface MigrationStatus {
  run: MigrationRun;
  dirty: DirtyCounts;
}

/** Migration controller returned by `createMigration`. */
export interface MigrationController {
  preflight(): Promise<PreflightResult>;
  enableKeyspaceNotifications(opts?: EnableKeyspaceNotificationsOptions): Promise<SetKeyspaceEventsResult>;
  startDirtyTracker(opts?: ControllerDirtyTrackerOptions): Promise<{ running: true }>;
  stopDirtyTracker(): Promise<{ running: false }>;
  bulk(opts?: ControllerBulkOptions): Promise<MigrationRun | undefined>;
  status(): MigrationStatus | null;
  applyDirty(opts?: ControllerApplyDirtyOptions): Promise<MigrationRun | undefined>;
  verify(opts?: ControllerVerifyOptions): Promise<VerifyResult>;
  migrateSearch(opts?: ControllerMigrateSearchOptions): Promise<MigrateSearchResult>;
  close(): Promise<void>;
}

/**
 * Create a migration controller bound to a source Redis and destination DB.
 */
export function createMigration({
  from = 'redis://127.0.0.1:6379',
  to,
  runId,
  pragmaTemplate = 'default',
  scanCount = 1000,
  maxRps = 0,
  concurrency = 1,
  estimatedTotalKeys = 0,
  batchKeys = 200,
  batchBytes = 64 * 1024 * 1024,
  configCommand = 'CONFIG',
}: MigrationOptions = {} as MigrationOptions): MigrationController {
  if (!to) throw new Error('createMigration: "to" (db path) is required');

  let _client: ReturnType<typeof createClient> | null = null;
  let _tracker: DirtyTracker | null = null;

  async function getClient(): Promise<ReturnType<typeof createClient>> {
    if (_client) return _client;
    _client = createClient({ url: from });
    _client.on('error', (err: Error) => {
      /* non-fatal connection errors; callers surface them on next await */
      void err;
    });
    await _client.connect();
    return _client;
  }

  function requireRunId(): string {
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
     */
    async enableKeyspaceNotifications({ value = 'KEA', merge = true }: EnableKeyspaceNotificationsOptions = {}) {
      const client = await getClient();
      return setKeyspaceEvents(client, value, { configCommand, merge });
    },

    /**
     * Start dirty-key tracking in-process for this migration controller.
     * Use this to run the full minimal-downtime flow in one Node script.
     */
    async startDirtyTracker({ pragmaTemplate: pt = pragmaTemplate, onProgress }: ControllerDirtyTrackerOptions = {}) {
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
     */
    async bulk({
      resume = true,
      concurrency: c = concurrency,
      estimatedTotalKeys: et = estimatedTotalKeys,
      onProgress,
    }: ControllerBulkOptions = {}) {
      const id = requireRunId();
      const client = await getClient();
      return runBulkImport(client, to, id, {
        sourceUri: from,
        pragmaTemplate,
        scan_count: scanCount,
        max_rps: maxRps,
        concurrency: c,
        estimated_total_keys: et,
        batch_keys: batchKeys,
        batch_bytes: batchBytes,
        resume,
        onProgress,
      });
    },

    /**
     * Step 2 — Status: read run metadata and dirty-key counts from the DB.
     * Synchronous — no Redis connection needed.
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
     */
    async applyDirty({
      batchKeys: bk = batchKeys,
      maxRps: rps = maxRps,
      concurrency: c = concurrency,
      progressIntervalMs: pim = 2000,
      onProgress,
    }: ControllerApplyDirtyOptions = {}) {
      const id = requireRunId();
      const client = await getClient();
      return runApplyDirty(client, to, id, {
        pragmaTemplate,
        batch_keys: bk,
        max_rps: rps,
        concurrency: c,
        progress_interval_ms: pim,
        onProgress,
      });
    },

    /**
     * Step 4 — Verify: sample keys from Redis and compare with the destination DB.
     */
    async verify({ samplePct = 0.5, maxSample = 10000 }: ControllerVerifyOptions = {}) {
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
     */
    async migrateSearch(opts: ControllerMigrateSearchOptions = {}) {
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
export { startDirtyTracker } from './tracker.ts';
export { getRun, getDirtyCounts, createRun, setRunStatus, logError } from './registry.ts';
export type {
  KeyspaceEventsReadResult,
  SetKeyspaceEventsOptions,
  SetKeyspaceEventsResult,
  PreflightOptions,
  PreflightResult,
} from './preflight.ts';
export type { BulkImportOptions, BulkProgress } from './bulk.ts';
export type { ApplyDirtyOptions, DirtyProgress } from './apply-dirty.ts';
export type { VerifyOptions, VerifyMismatch, VerifyResult } from './verify.ts';
export type { MigrateSearchOptions, MigrateSearchResult, IndexResult } from './migrate-search.ts';
export type { DirtyTracker, DirtyTrackerOptions, DirtyTrackerProgress } from './tracker.ts';
export type {
  MigrationRun,
  RunStatus,
  DirtyKeyState,
  DirtyCounts,
  MigrationErrorStage,
  CreateRunOptions,
  CreateRunResult,
} from './registry.ts';
export type { MigrationRedisClient, MigrationScanReply } from './redis-client.ts';
