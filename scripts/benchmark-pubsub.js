#!/usr/bin/env node
/**
 * Comparative Pub/Sub benchmark: Redis vs RESPlite.
 *
 * Connection setup and subscription acknowledgements are excluded from the
 * measured interval. Each scenario measures sequential PUBLISH commands until
 * every expected subscriber delivery has arrived.
 */

import { createClient } from 'redis';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.join(path.dirname(SCRIPT_PATH), '..');
const VALID_TEMPLATES = new Set(['default', 'performance', 'safety', 'minimal', 'none']);

const DEFAULTS = Object.freeze({
  iterations: 2000,
  warmup: 100,
  subscribers: [0, 1, 10, 100],
  messageSizes: [64, 1024],
  redisPort: 6379,
  resplitePort: 6380,
  template: 'default',
  timeoutMs: 30000,
  respliteOnly: false,
  help: false,
});

const HELP = `Usage:
  node scripts/benchmark-pubsub.js [options]

Options:
  --iterations N         Measured publications per scenario (default: 2000)
  --warmup N             Warmup publications per scenario (default: 100)
  --subscribers LIST     Comma-separated subscriber counts (default: 0,1,10,100)
  --message-sizes LIST   Comma-separated payload sizes in bytes (default: 64,1024)
  --redis-port P         Redis port (default: 6379)
  --resplite-port P      RESPlite port (default: 6380)
  --template NAME        RESPlite PRAGMA template (default: default)
  --timeout-ms N         Delivery timeout per phase (default: 30000)
  --resplite-only        Skip Redis
  --help                 Show this help
`;

function parseInteger(value, option, minimum) {
  if (!/^\d+$/.test(value ?? '')) {
    throw new Error(`${option} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${option} must be at least ${minimum}`);
  }
  return parsed;
}

function parseIntegerList(value, option, minimum) {
  if (!value) throw new Error(`${option} requires a comma-separated list`);
  const values = value.split(',').map((item) => parseInteger(item, option, minimum));
  return [...new Set(values)];
}

export function parseArgs(args = process.argv.slice(2)) {
  const options = {
    ...DEFAULTS,
    subscribers: [...DEFAULTS.subscribers],
    messageSizes: [...DEFAULTS.messageSizes],
  };

  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--iterations') {
      options.iterations = parseInteger(args[++i], option, 1);
    } else if (option === '--warmup') {
      options.warmup = parseInteger(args[++i], option, 0);
    } else if (option === '--subscribers') {
      options.subscribers = parseIntegerList(args[++i], option, 0);
    } else if (option === '--message-sizes') {
      options.messageSizes = parseIntegerList(args[++i], option, 12);
    } else if (option === '--redis-port') {
      options.redisPort = parseInteger(args[++i], option, 1);
    } else if (option === '--resplite-port') {
      options.resplitePort = parseInteger(args[++i], option, 1);
    } else if (option === '--template') {
      const template = args[++i];
      if (!VALID_TEMPLATES.has(template)) {
        throw new Error(`--template must be one of: ${[...VALID_TEMPLATES].join(', ')}`);
      }
      options.template = template;
    } else if (option === '--timeout-ms') {
      options.timeoutMs = parseInteger(args[++i], option, 1);
    } else if (option === '--resplite-only') {
      options.respliteOnly = true;
    } else if (option === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }

  return options;
}

export function buildScenarios(subscriberCounts, messageSizes) {
  const scenarios = [];
  for (const messageBytes of messageSizes) {
    for (const subscribers of subscriberCounts) {
      const modes = subscribers === 0 ? ['direct'] : ['direct', 'pattern'];
      for (const mode of modes) {
        scenarios.push({
          id: `${mode}:${subscribers}:${messageBytes}`,
          mode,
          subscribers,
          messageBytes,
        });
      }
    }
  }
  return scenarios;
}

export function createPayload(marker, sequence, messageBytes) {
  const header = `${marker}${String(sequence).padStart(10, '0')}:`;
  if (header.length > messageBytes) {
    throw new Error(`message size must be at least ${header.length} bytes`);
  }
  return header + 'x'.repeat(messageBytes - header.length);
}

export function summarizeLatencies(values) {
  if (values.length === 0) return { p50: null, p95: null, p99: null };
  const sorted = Array.from(values).sort((a, b) => a - b);
  const at = (quantile) => sorted[Math.ceil(sorted.length * quantile) - 1];
  return { p50: at(0.50), p95: at(0.95), p99: at(0.99) };
}

function makeGate(target) {
  let count = 0;
  let finish;
  const promise = target === 0
    ? Promise.resolve()
    : new Promise((resolve) => { finish = resolve; });
  return {
    increment() {
      count++;
      if (count === target) finish();
    },
    release() {
      finish?.();
    },
    promise,
    get count() {
      return count;
    },
  };
}

function createDeliveryTracker({ subscribers, warmup, iterations }) {
  const warmupGate = makeGate(subscribers * warmup);
  const measuredGate = makeGate(subscribers * iterations);
  const sentAt = new Float64Array(iterations);
  const latencies = new Float64Array(subscribers * iterations);
  let latencyIndex = 0;
  let failure = null;

  function fail(error) {
    if (failure) return;
    failure = error;
    warmupGate.release();
    measuredGate.release();
  }

  return {
    listener(message) {
      try {
        if (message[0] === 'w') {
          warmupGate.increment();
          return;
        }
        if (message[0] !== 'm') throw new Error('received an unknown benchmark payload');
        const sequence = Number(message.slice(1, 11));
        if (!Number.isInteger(sequence) || sequence < 0 || sequence >= iterations) {
          throw new Error(`received invalid benchmark sequence: ${message.slice(0, 12)}`);
        }
        if (sentAt[sequence] === 0) {
          throw new Error(`received sequence ${sequence} before it was published`);
        }
        if (latencyIndex >= latencies.length) {
          throw new Error('received more Pub/Sub deliveries than expected');
        }
        latencies[latencyIndex++] = performance.now() - sentAt[sequence];
        measuredGate.increment();
      } catch (error) {
        fail(error);
      }
    },
    markSent(sequence) {
      sentAt[sequence] = performance.now();
    },
    async waitForWarmup(timeoutMs) {
      await waitWithTimeout(warmupGate.promise, timeoutMs, 'warmup deliveries');
      if (failure) throw failure;
    },
    async waitForMeasured(timeoutMs) {
      await waitWithTimeout(measuredGate.promise, timeoutMs, 'measured deliveries');
      if (failure) throw failure;
      if (latencyIndex !== latencies.length) {
        throw new Error(`received ${latencyIndex} of ${latencies.length} measured deliveries`);
      }
    },
    latencies,
  };
}

async function waitWithTimeout(promise, timeoutMs, description) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function clientFor(port) {
  return createClient({
    socket: {
      host: '127.0.0.1',
      port,
      reconnectStrategy: false,
    },
  });
}

async function connect(name, port) {
  const client = clientFor(port);
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch (error) {
    await closeClient(client);
    throw new Error(`cannot connect to ${name} on port ${port}: ${error.message}`);
  }
}

async function closeClient(client) {
  if (!client?.isOpen) return;
  try {
    await client.quit();
  } catch (_) {
    if (client.isOpen) client.disconnect();
  }
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => reject(new Error(`RESPlite port ${port} is unavailable: ${error.message}`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

async function waitForResplite(child, port, stderr, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`RESPlite exited before startup${stderr.value ? `: ${stderr.value.trim()}` : ''}`);
    }
    try {
      const client = await connect('RESPlite', port);
      await closeClient(client);
      return;
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`RESPlite on port ${port} did not become ready in time${stderr.value ? `: ${stderr.value.trim()}` : ''}`);
}

function spawnResplite(options) {
  const config = {
    port: options.resplitePort,
    dbPath: ':memory:',
    pragmaTemplate: options.template,
    cache: false,
  };
  const child = spawn(process.execPath, ['scripts/benchmark-resplite-instance.js'], {
    env: {
      ...process.env,
      RESPLITE_BENCH_CONFIG: JSON.stringify(config),
    },
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr = { value: '' };
  child.stderr.on('data', (chunk) => {
    stderr.value = (stderr.value + chunk.toString('utf8')).slice(-4096);
  });
  return { child, stderr };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function createSubscribers(port, count) {
  const clients = Array.from({ length: count }, () => clientFor(port));
  try {
    await Promise.all(clients.map((client) => client.connect()));
    return clients;
  } catch (error) {
    await Promise.allSettled(clients.map(closeClient));
    throw error;
  }
}

async function runScenario(target, scenario, options, scenarioIndex) {
  const subscribers = await createSubscribers(target.port, scenario.subscribers);
  const tracker = createDeliveryTracker({
    subscribers: scenario.subscribers,
    warmup: options.warmup,
    iterations: options.iterations,
  });
  const namespace = `bm:pubsub:${process.pid}:${scenarioIndex}`;
  const channel = `${namespace}:events`;
  const pattern = `${namespace}:*`;

  try {
    await Promise.all(subscribers.map((client) => (
      scenario.mode === 'pattern'
        ? client.pSubscribe(pattern, tracker.listener)
        : client.subscribe(channel, tracker.listener)
    )));

    for (let i = 0; i < options.warmup; i++) {
      const receivers = await target.publisher.publish(
        channel,
        createPayload('w', i, scenario.messageBytes)
      );
      if (receivers !== scenario.subscribers) {
        throw new Error(`PUBLISH reported ${receivers} receivers; expected ${scenario.subscribers}`);
      }
    }
    await tracker.waitForWarmup(options.timeoutMs);

    const startedAt = performance.now();
    for (let i = 0; i < options.iterations; i++) {
      tracker.markSent(i);
      const receivers = await target.publisher.publish(
        channel,
        createPayload('m', i, scenario.messageBytes)
      );
      if (receivers !== scenario.subscribers) {
        throw new Error(`PUBLISH reported ${receivers} receivers; expected ${scenario.subscribers}`);
      }
    }
    await tracker.waitForMeasured(options.timeoutMs);
    const elapsedMs = performance.now() - startedAt;
    const deliveries = options.iterations * scenario.subscribers;

    return {
      target: target.name,
      scenario,
      elapsedMs,
      publishesPerSecond: options.iterations * 1000 / elapsedMs,
      deliveriesPerSecond: deliveries === 0 ? null : deliveries * 1000 / elapsedMs,
      ...summarizeLatencies(tracker.latencies),
    };
  } finally {
    await Promise.allSettled(subscribers.map(closeClient));
  }
}

function formatRate(value) {
  if (value === null) return '—';
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(2);
}

function formatMs(value) {
  if (value === null) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  if (value >= 1) return `${value.toFixed(2)}ms`;
  return `${(value * 1000).toFixed(0)}µs`;
}

function formatBytes(value) {
  return value >= 1024 ? `${value / 1024} KiB` : `${value} B`;
}

function scenarioName(scenario) {
  const mode = scenario.mode === 'direct' ? 'channel' : 'pattern';
  return `${mode}, ${scenario.subscribers} sub, ${formatBytes(scenario.messageBytes)}`;
}

function printTable(results) {
  const rows = results.map((result) => [
    scenarioName(result.scenario),
    result.target,
    formatRate(result.publishesPerSecond),
    formatRate(result.deliveriesPerSecond),
    formatMs(result.p50),
    formatMs(result.p95),
    formatMs(result.p99),
  ]);
  const headers = ['Scenario', 'Server', 'Publish/s', 'Deliveries/s', 'p50', 'p95', 'p99'];
  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map((row) => row[column].length)
  ));
  const render = (row) => row.map((value, column) => (
    column < 2 ? value.padEnd(widths[column]) : value.padStart(widths[column])
  )).join(' | ');

  console.log(render(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('-|-'));
  for (const row of rows) console.log(render(row));
}

function printRatios(results, scenarios) {
  const byKey = new Map(results.map((result) => [`${result.scenario.id}:${result.target}`, result]));
  const ratios = scenarios.flatMap((scenario) => {
    const redis = byKey.get(`${scenario.id}:Redis`);
    const resplite = byKey.get(`${scenario.id}:RESPlite`);
    if (!redis || !resplite) return [];
    return [[scenarioName(scenario), `${(resplite.publishesPerSecond / redis.publishesPerSecond).toFixed(2)}x`]];
  });
  if (ratios.length === 0) return;

  const scenarioWidth = Math.max('Scenario'.length, ...ratios.map(([name]) => name.length));
  console.log('');
  console.log('RESPlite publish throughput relative to Redis:');
  console.log(`${'Scenario'.padEnd(scenarioWidth)} | Ratio`);
  console.log(`${'-'.repeat(scenarioWidth)}-|------`);
  for (const [name, ratio] of ratios) console.log(`${name.padEnd(scenarioWidth)} | ${ratio.padStart(5)}`);
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const scenarios = buildScenarios(options.subscribers, options.messageSizes);
  const results = [];
  const targets = [];
  let respliteChild;

  console.log('Benchmark: Redis vs RESPlite Pub/Sub');
  console.log(`  Iterations: ${options.iterations}; warmup: ${options.warmup}`);
  console.log(`  Subscribers: ${options.subscribers.join(', ')}`);
  console.log(`  Payloads: ${options.messageSizes.map(formatBytes).join(', ')}`);
  console.log(`  Redis: ${options.respliteOnly ? 'skipped' : `127.0.0.1:${options.redisPort}`}`);
  console.log(`  RESPlite: 127.0.0.1:${options.resplitePort} (${options.template}, in-memory DB, cache off)`);
  console.log('  Setup and subscription acknowledgements are not timed.');
  console.log('');

  try {
    await assertPortAvailable(options.resplitePort);
    const spawned = spawnResplite(options);
    respliteChild = spawned.child;
    await waitForResplite(spawned.child, options.resplitePort, spawned.stderr);

    if (!options.respliteOnly) {
      targets.push({
        name: 'Redis',
        port: options.redisPort,
        publisher: await connect('Redis', options.redisPort),
      });
    }
    targets.push({
      name: 'RESPlite',
      port: options.resplitePort,
      publisher: await connect('RESPlite', options.resplitePort),
    });

    for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
      const scenario = scenarios[scenarioIndex];
      for (const target of targets) {
        process.stdout.write(`  ${scenarioName(scenario)} / ${target.name} ... `);
        const result = await runScenario(target, scenario, options, scenarioIndex);
        results.push(result);
        console.log(`${formatRate(result.publishesPerSecond)} publish/s, p99 ${formatMs(result.p99)}`);
      }
    }
  } finally {
    await Promise.allSettled(targets.map((target) => closeClient(target.publisher)));
    await stopChild(respliteChild);
  }

  console.log('');
  console.log('Summary:');
  printTable(results);
  printRatios(results, scenarios);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
