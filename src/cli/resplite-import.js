#!/usr/bin/env node
/**
 * resplite-import CLI (SPEC_F §F.9): preflight, bulk, status, apply-dirty, verify.
 * Usage: resplite-import <preflight|bulk|status|apply-dirty|verify> [options]
 */

import { createClient } from 'redis';
import { fileURLToPath } from 'node:url';
import { openDb } from '../storage/sqlite/db.js';
import { runPreflight } from '../migration/preflight.js';
import { runBulkImport } from '../migration/bulk.js';
import { runApplyDirty } from '../migration/apply-dirty.js';
import { runVerify } from '../migration/verify.js';
import { runMigrateSearch } from '../migration/migrate-search.js';
import { getRun, getDirtyCounts } from '../migration/registry.js';

const SUBCOMMANDS = ['preflight', 'bulk', 'status', 'apply-dirty', 'verify', 'migrate-search'];

function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from' && argv[i + 1]) {
      args.from = argv[++i];
    } else if (arg === '--to' && argv[i + 1]) {
      args.to = argv[++i];
    } else if (arg === '--run-id' && argv[i + 1]) {
      args.runId = argv[++i];
    } else if (arg === '--scan-count' && argv[i + 1]) {
      args.scanCount = parseInt(argv[++i], 10);
    } else if (arg === '--max-concurrency' && argv[i + 1]) {
      args.maxConcurrency = parseInt(argv[++i], 10);
    } else if (arg === '--max-rps' && argv[i + 1]) {
      args.maxRps = parseInt(argv[++i], 10);
    } else if (arg === '--batch-keys' && argv[i + 1]) {
      args.batchKeys = parseInt(argv[++i], 10);
    } else if (arg === '--batch-bytes' && argv[i + 1]) {
      const v = argv[++i];
      const match = v.match(/^(\d+)(MB|KB|GB)?$/i);
      if (match) {
        let n = parseInt(match[1], 10);
        if (match[2]) {
          if (match[2].toUpperCase() === 'KB') n *= 1024;
          else if (match[2].toUpperCase() === 'MB') n *= 1024 * 1024;
          else if (match[2].toUpperCase() === 'GB') n *= 1024 * 1024 * 1024;
        }
        args.batchBytes = n;
      }
    } else if (arg === '--resume') {
      args.resume = true;
    } else if (arg === '--no-resume') {
      args.resume = false;
    } else if (arg === '--pragma-template' && argv[i + 1]) {
      args.pragmaTemplate = argv[++i];
    } else if (arg === '--sample' && argv[i + 1]) {
      args.sample = argv[++i];
    } else if (arg === '--index' && argv[i + 1]) {
      if (!args.index) args.index = [];
      args.index.push(argv[++i]);
    } else if (arg === '--batch-docs' && argv[i + 1]) {
      args.batchDocs = parseInt(argv[++i], 10);
    } else if (arg === '--max-suggestions' && argv[i + 1]) {
      args.maxSuggestions = parseInt(argv[++i], 10);
    } else if (arg === '--no-skip') {
      args.noSkip = true;
    } else if (arg === '--no-suggestions') {
      args.noSuggestions = true;
    } else if (arg.startsWith('--')) {
      args[arg.slice(2).replace(/-/g, '')] = argv[i + 1] ?? true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function getRedisUrl(args) {
  return args.from || process.env.RESPLITE_IMPORT_FROM || 'redis://127.0.0.1:6379';
}

function getDbPath(args) {
  if (!args.to) {
    console.error('Missing --to <db-path>');
    process.exit(1);
  }
  return args.to;
}

function getRunId(args, required = false) {
  const id = args.runId || process.env.RESPLITE_RUN_ID;
  if (required && !id) {
    console.error('Missing --run-id <id>');
    process.exit(1);
  }
  return id;
}

async function cmdPreflight(args) {
  const redisUrl = getRedisUrl(args);
  const client = createClient({ url: redisUrl });
  client.on('error', (e) => console.error('Redis:', e.message));
  await client.connect();
  try {
    const result = await runPreflight(client);
    console.log('Preflight:');
    console.log('  Key count (estimate):', result.keyCountEstimate);
    console.log('  Type distribution (sample):', result.typeDistribution);
    console.log('  notify-keyspace-events:', result.notifyKeyspaceEvents ?? '(not set or not readable)');
    if (!result.notifyKeyspaceEvents || result.notifyKeyspaceEvents === '') {
      console.warn('  WARNING: Keyspace notifications disabled. Enable for dirty-key tracker (e.g. "Kgxe").');
    }
    console.log('  Recommended:');
    console.log('    --scan-count', result.recommended.scan_count);
    console.log('    --max-concurrency', result.recommended.max_concurrency);
    console.log('    --max-rps', result.recommended.max_rps);
  } finally {
    await client.quit();
  }
}

async function cmdBulk(args) {
  const redisUrl = getRedisUrl(args);
  const dbPath = getDbPath(args);
  const runId = getRunId(args, true);
  const client = createClient({ url: redisUrl });
  client.on('error', (e) => console.error('Redis:', e.message));
  await client.connect();
  try {
    const run = await runBulkImport(client, dbPath, runId, {
      sourceUri: redisUrl,
      pragmaTemplate: args.pragmaTemplate || 'default',
      scan_count: args.scanCount || 1000,
      max_rps: args.maxRps || 0,
      batch_keys: args.batchKeys || 200,
      batch_bytes: args.batchBytes || 64 * 1024 * 1024,
      resume: args.resume !== false, // default true: start from 0 or continue from checkpoint
      onProgress: (r) => {
        console.log(`  scanned=${r.scanned_keys} migrated=${r.migrated_keys} skipped=${r.skipped_keys} errors=${r.error_keys} cursor=${r.scan_cursor}`);
      },
    });
    console.log('Bulk complete:', run);
  } finally {
    await client.quit();
  }
}

async function cmdStatus(args) {
  const dbPath = getDbPath(args);
  const runId = getRunId(args, true);
  const db = openDb(dbPath, { pragmaTemplate: args.pragmaTemplate || 'default' });
  const run = getRun(db, runId);
  if (!run) {
    console.error('Run not found:', runId);
    process.exit(1);
  }
  const dirty = getDirtyCounts(db, runId);
  console.log('Run:', runId);
  console.log('  status:', run.status);
  console.log('  source:', run.source_uri);
  console.log('  scan_cursor:', run.scan_cursor);
  console.log('  scanned_keys:', run.scanned_keys, 'migrated_keys:', run.migrated_keys, 'skipped_keys:', run.skipped_keys, 'error_keys:', run.error_keys);
  console.log('  migrated_bytes:', run.migrated_bytes);
  console.log('  dirty_keys: seen=', run.dirty_keys_seen, 'applied=', run.dirty_keys_applied, 'deleted=', run.dirty_keys_deleted);
  console.log('  dirty by state:', dirty);
  if (run.last_error) console.log('  last_error:', run.last_error);
}

async function cmdApplyDirty(args) {
  const redisUrl = getRedisUrl(args);
  const dbPath = getDbPath(args);
  const runId = getRunId(args, true);
  const client = createClient({ url: redisUrl });
  client.on('error', (e) => console.error('Redis:', e.message));
  await client.connect();
  try {
    const run = await runApplyDirty(client, dbPath, runId, {
      pragmaTemplate: args.pragmaTemplate || 'default',
      batch_keys: args.batchKeys || 200,
      max_rps: args.maxRps || 0,
    });
    console.log('Apply-dirty complete:', run);
  } finally {
    await client.quit();
  }
}

async function cmdVerify(args) {
  const redisUrl = getRedisUrl(args);
  const dbPath = getDbPath(args);
  const client = createClient({ url: redisUrl });
  client.on('error', (e) => console.error('Redis:', e.message));
  await client.connect();
  try {
    let samplePct = 0.5;
    if (args.sample) {
      const m = args.sample.match(/^(\d*\.?\d+)\s*%?$/);
      if (m) samplePct = parseFloat(m[1]);
    }
    const result = await runVerify(client, dbPath, {
      pragmaTemplate: args.pragmaTemplate || 'default',
      samplePct,
      maxSample: 10000,
    });
    console.log('Verify: sampled=', result.sampled, 'matched=', result.matched, 'mismatches=', result.mismatches.length);
    if (result.mismatches.length) {
      result.mismatches.slice(0, 20).forEach((m) => console.log('  ', m.key, m.reason));
      if (result.mismatches.length > 20) console.log('  ... and', result.mismatches.length - 20, 'more');
    }
  } finally {
    await client.quit();
  }
}

async function cmdMigrateSearch(args) {
  const redisUrl = getRedisUrl(args);
  const dbPath   = getDbPath(args);
  const client   = createClient({ url: redisUrl });
  client.on('error', (e) => console.error('Redis:', e.message));
  await client.connect();
  try {
    const onlyIndices = args.index
      ? (Array.isArray(args.index) ? args.index : [args.index])
      : null;

    const result = await runMigrateSearch(client, dbPath, {
      pragmaTemplate:  args.pragmaTemplate || 'default',
      onlyIndices,
      scanCount:       args.scanCount       || 500,
      maxRps:          args.maxRps          || 0,
      batchDocs:       args.batchDocs       || 200,
      maxSuggestions:  args.maxSuggestions  || 10000,
      skipExisting:    args.noSkip ? false : true,
      withSuggestions: args.noSuggestions ? false : true,
      onProgress: (r) => {
        const status = r.error ? `ERROR: ${r.error}` : (r.skipped ? 'skipped (already exists)' : 'created');
        console.log(`  [${r.name}] ${status} — docs=${r.docsImported} skipped=${r.docsSkipped} errors=${r.docErrors} sugs=${r.sugsImported}`);
        if (r.warnings?.length) r.warnings.forEach((w) => console.log(`    WARN: ${w}`));
      },
    });

    if (result.aborted) console.log('Migration aborted by signal.');
    console.log(`Done. Indices processed: ${result.indices.length}`);
    const errors = result.indices.filter((i) => i.error);
    if (errors.length) {
      console.error(`  ${errors.length} index(es) failed:`);
      errors.forEach((i) => console.error(`  - ${i.name}: ${i.error}`));
    }
  } finally {
    await client.quit();
  }
}

async function main() {
  const args = parseArgs();
  const sub = args._[0];
  if (!SUBCOMMANDS.includes(sub)) {
    console.error('Usage: resplite-import <preflight|bulk|status|apply-dirty|verify|migrate-search> [options]');
    console.error('  --from <redis-url>       (default: redis://127.0.0.1:6379)');
    console.error('  --to <db-path>           (required for bulk, status, apply-dirty, verify, migrate-search)');
    console.error('  --run-id <id>            (required for bulk, status, apply-dirty)');
    console.error('  --scan-count N           (bulk / migrate-search, default 1000 / 500)');
    console.error('  --max-rps N              (bulk, apply-dirty, migrate-search)');
    console.error('  --batch-keys N           (default 200)');
    console.error('  --batch-bytes N[MB|KB|GB](default 64MB)');
    console.error('  --resume / --no-resume   (bulk: default resume=on)');
    console.error('  --sample 0.5%            (verify, default 0.5%)');
    console.error('  --index <name>           (migrate-search: repeat for multiple; omit for all indices)');
    console.error('  --batch-docs N           (migrate-search: docs per SQLite tx, default 200)');
    console.error('  --max-suggestions N      (migrate-search: cap for FT.SUGGET, default 10000)');
    console.error('  --no-skip                (migrate-search: overwrite if index exists)');
    console.error('  --no-suggestions         (migrate-search: skip suggestion import)');
    process.exit(1);
  }
  try {
    if (sub === 'preflight')       await cmdPreflight(args);
    else if (sub === 'bulk')       await cmdBulk(args);
    else if (sub === 'status')     await cmdStatus(args);
    else if (sub === 'apply-dirty')await cmdApplyDirty(args);
    else if (sub === 'verify')     await cmdVerify(args);
    else if (sub === 'migrate-search') await cmdMigrateSearch(args);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1]?.endsWith('resplite-import.js');
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { parseArgs, cmdPreflight, cmdBulk, cmdStatus, cmdApplyDirty, cmdVerify, cmdMigrateSearch };
