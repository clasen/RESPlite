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
import { openDb } from '../storage/sqlite/db.js';
import { createRun, upsertDirtyKey, logError } from './registry.js';
import { readKeyspaceEvents } from './preflight.js';

const KEYEVENT_PATTERN = '__keyevent@0__:*';

/**
 * Start the dirty-key tracker: connect a subscriber client and record every
 * keyspace event into the migration registry.
 *
 * Resolves once the subscription is active. Call `stop()` to disconnect.
 *
 * @param {object} options
 * @param {string} [options.from='redis://127.0.0.1:6379'] - Source Redis URL.
 * @param {string} options.to                              - SQLite DB path (must already exist or be created by bulk).
 * @param {string} options.runId                           - Migration run identifier.
 * @param {string} [options.pragmaTemplate='default']
 * @param {string} [options.configCommand='CONFIG']        - CONFIG command name (in case it was renamed).
 * @param {(progress: {
 *   runId: string,
 *   key: string,
 *   event: string,
 *   totalEvents: number,
 *   at: string
 * }) => void | Promise<void>} [options.onProgress]        - Called for each tracked keyspace event.
 * @returns {Promise<{ stop(): Promise<void> }>}
 * @throws {Error} If keyspace notifications are not enabled on Redis.
 */
export async function startDirtyTracker({
  from = 'redis://127.0.0.1:6379',
  to,
  runId,
  pragmaTemplate = 'default',
  configCommand = 'CONFIG',
  onProgress,
} = {}) {
  if (!to) throw new Error('startDirtyTracker: "to" (db path) is required');
  if (!runId) throw new Error('startDirtyTracker: "runId" is required');

  const db = openDb(to, { pragmaTemplate });
  createRun(db, runId, from); // idempotent — safe to call even if bulk already created the run

  const mainClient = createClient({ url: from });
  mainClient.on('error', (err) =>
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
  subClient.on('error', (err) =>
    logError(db, runId, 'dirty_apply', 'Tracker subscriber error: ' + err.message, null)
  );
  await subClient.connect();

  let totalEvents = 0;
  await subClient.pSubscribe(KEYEVENT_PATTERN, (message, channel) => {
    const event = typeof channel === 'string'
      ? channel.split(':').pop()
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
        ).catch((err) => {
          logError(db, runId, 'dirty_apply', 'Tracker onProgress error: ' + err.message, message);
        });
      }
    } catch (err) {
      logError(db, runId, 'dirty_apply', err.message, message);
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
