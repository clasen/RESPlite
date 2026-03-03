#!/usr/bin/env node
/**
 * resplite-dirty-tracker (SPEC_F §F.6): subscribe to Redis keyspace notifications, record dirty keys in SQLite.
 * Usage: resplite-dirty-tracker start|stop [options]
 */

import { createClient } from 'redis';
import { fileURLToPath } from 'node:url';
import { openDb } from '../storage/sqlite/db.js';
import { createRun, getRun, setRunStatus, upsertDirtyKey, logError, RUN_STATUS } from '../migration/registry.js';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from' && argv[i + 1]) args.from = argv[++i];
    else if (arg === '--to' && argv[i + 1]) args.to = argv[++i];
    else if (arg === '--run-id' && argv[i + 1]) args.runId = argv[++i];
    else if (arg === '--channels' && argv[i + 1]) args.channels = argv[++i];
    else if (arg === '--pragma-template' && argv[i + 1]) args.pragmaTemplate = argv[++i];
    else if (!arg.startsWith('--')) args._.push(arg);
  }
  return args;
}

async function checkKeyspaceNotifications(client) {
  let val = null;
  try {
    const config = await client.configGet('notify-keyspace-events');
    val = config && typeof config === 'object' ? config['notify-keyspace-events'] : null;
  } catch (_) {}
  if (!val || val === '') {
    throw new Error('Redis notify-keyspace-events is not set. Enable it (e.g. CONFIG SET notify-keyspace-events Kgxe) for the dirty-key tracker.');
  }
  return val;
}

async function startTracker(args) {
  const redisUrl = args.from || process.env.RESPLITE_IMPORT_FROM || 'redis://127.0.0.1:6379';
  const dbPath = args.to;
  const runId = args.runId || process.env.RESPLITE_RUN_ID;
  if (!dbPath || !runId) {
    console.error('Usage: resplite-dirty-tracker start --run-id <id> --to <db-path> [--from <redis-url>] [--channels keyevent]');
    process.exit(1);
  }

  const db = openDb(dbPath, { pragmaTemplate: args.pragmaTemplate || 'default' });
  createRun(db, runId, redisUrl);

  const mainClient = createClient({ url: redisUrl });
  mainClient.on('error', (e) => console.error('Redis (main):', e.message));
  await mainClient.connect();
  await checkKeyspaceNotifications(mainClient);

  const subClient = mainClient.duplicate();
  subClient.on('error', (e) => {
    console.error('Redis (sub):', e.message);
    logError(db, runId, 'dirty_apply', 'Tracker disconnect: ' + e.message, null);
  });
  await subClient.connect();

  const pattern = '__keyevent@0__:*';
  console.log('Subscribing to', pattern, '...');

  await subClient.pSubscribe(pattern, (message, channel) => {
    const event = typeof channel === 'string' ? channel.split(':').pop() : (channel && channel.toString?.())?.split(':').pop() || 'unknown';
    const key = message;
    try {
      upsertDirtyKey(db, runId, key, event);
    } catch (err) {
      logError(db, runId, 'dirty_apply', err.message, key);
    }
  });

  const shutdown = async () => {
    console.log('Stopping dirty tracker...');
    await subClient.pUnsubscribe(pattern);
    await subClient.quit();
    await mainClient.quit();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log('Dirty tracker running. Ctrl+C to stop.');
}

async function stopTracker(args) {
  const dbPath = args.to;
  const runId = args.runId || process.env.RESPLITE_RUN_ID;
  if (!dbPath || !runId) {
    console.error('Usage: resplite-dirty-tracker stop --run-id <id> --to <db-path>');
    process.exit(1);
  }
  const db = openDb(dbPath, { pragmaTemplate: args.pragmaTemplate || 'default' });
  const run = getRun(db, runId);
  if (run && run.status === RUN_STATUS.RUNNING) {
    setRunStatus(db, runId, RUN_STATUS.PAUSED);
    console.log('Run', runId, 'status set to paused. Tracker process must be stopped with Ctrl+C if still running.');
  } else {
    console.log('Run', runId, 'status:', run?.status ?? 'not found');
  }
}

async function main() {
  const args = parseArgs();
  const sub = args._[0];
  if (sub === 'start') await startTracker(args);
  else if (sub === 'stop') await stopTracker(args);
  else {
    console.error('Usage: resplite-dirty-tracker <start|stop> --run-id <id> --to <db-path> [--from <redis-url>]');
    process.exit(1);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1]?.endsWith('resplite-dirty-tracker.js');
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { parseArgs, startTracker, stopTracker };
