/**
 * Dirty-key tracker: subscribe to Redis keyspace notifications and record
 * modified/deleted keys in the migration registry (SPEC_F §F.6).
 *
 * Programmatic API:
 *   const tracker = await startDirtyTracker({ from, to, runId });
 *   // ... run bulk import and other Redis writes ...
 *   await tracker.stop();
 */

import { createClient } from 'redis';
import { openDb } from '../storage/sqlite/db.ts';
import { createRun, upsertDirtyKey, logError } from './registry.ts';
import { readKeyspaceEvents } from './preflight.ts';

const KEYEVENT_PATTERN = '__keyevent@0__:*';

/** Reported for each tracked keyspace event. */
export interface DirtyTrackerProgress {
  runId: string;
  key: string;
  event: string;
  totalEvents: number;
  at: string;
}

export interface DirtyTrackerOptions {
  /** Source Redis URL. Default `'redis://127.0.0.1:6379'`. */
  from?: string;
  /** SQLite DB path (must already exist or be created by bulk). */
  to: string;
  /** Migration run identifier. */
  runId: string;
  /** PRAGMA preset. Default `'default'`. */
  pragmaTemplate?: string;
  /** CONFIG command name (in case it was renamed). Default `'CONFIG'`. */
  configCommand?: string;
  /** Called for each tracked keyspace event. */
  onProgress?: (progress: DirtyTrackerProgress) => void | Promise<void>;
}

export interface DirtyTracker {
  /** Unsubscribe and disconnect. Safe to call multiple times. */
  stop(): Promise<void>;
}

/**
 * Start the dirty-key tracker: connect a subscriber client and record every
 * keyspace event into the migration registry.
 *
 * Resolves once the subscription is active. Call `stop()` to disconnect.
 *
 * @throws {Error} If keyspace notifications are not enabled on Redis.
 */
export async function startDirtyTracker({
  from = 'redis://127.0.0.1:6379',
  to,
  runId,
  pragmaTemplate = 'default',
  configCommand = 'CONFIG',
  onProgress,
}: DirtyTrackerOptions = {} as DirtyTrackerOptions): Promise<DirtyTracker> {
  if (!to) throw new Error('startDirtyTracker: "to" (db path) is required');
  if (!runId) throw new Error('startDirtyTracker: "runId" is required');

  const db = openDb(to, { pragmaTemplate });
  createRun(db, runId, from); // idempotent — safe to call even if bulk already created the run

  const mainClient = createClient({ url: from });
  mainClient.on('error', (err: Error) =>
    logError(db, runId, 'dirty_apply', 'Tracker connection error: ' + err.message, null)
  );
  await mainClient.connect();

  // Validate keyspace notifications before subscribing
  const { value: eventsValue, available } = await readKeyspaceEvents(mainClient, configCommand);
  if (!available || !eventsValue || eventsValue === '') {
    await mainClient.quit().catch(() => {});
    throw new Error(
      `Redis notify-keyspace-events is not set. ` +
      `Enable it first: ${configCommand} SET notify-keyspace-events KEA\n` +
      `Or call m.enableKeyspaceNotifications() from the programmatic API.`
    );
  }

  const subClient = mainClient.duplicate();
  subClient.on('error', (err: Error) =>
    logError(db, runId, 'dirty_apply', 'Tracker subscriber error: ' + err.message, null)
  );
  await subClient.connect();

  let totalEvents = 0;
  await subClient.pSubscribe(KEYEVENT_PATTERN, (message, channel) => {
    const event = typeof channel === 'string'
      ? channel.split(':').pop()!
      : String(channel ?? '').split(':').pop() || 'unknown';
    try {
      upsertDirtyKey(db, runId, message, event);
      totalEvents += 1;
      if (onProgress) {
        Promise.resolve(
          onProgress({
            runId,
            key: message,
            event,
            totalEvents,
            at: new Date().toISOString(),
          })
        ).catch((err: unknown) => {
          logError(db, runId, 'dirty_apply', 'Tracker onProgress error: ' + (err instanceof Error ? err.message : String(err)), message);
        });
      }
    } catch (err) {
      logError(db, runId, 'dirty_apply', err instanceof Error ? err.message : String(err), message);
    }
  });

  return {
    /**
     * Unsubscribe and disconnect. Safe to call multiple times.
     */
    async stop() {
      await subClient.pUnsubscribe(KEYEVENT_PATTERN).catch(() => {});
      await subClient.quit().catch(() => {});
      await mainClient.quit().catch(() => {});
    },
  };
}
