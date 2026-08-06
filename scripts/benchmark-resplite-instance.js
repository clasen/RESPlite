#!/usr/bin/env node
/**
 * Internal launcher used by the benchmark to start isolated RESPlite variants.
 * Configuration is passed as JSON to avoid adding benchmark-only environment
 * variables to the public CLI.
 */

import { startServer } from '../src/index.js';

const rawConfig = process.env.RESPLITE_BENCH_CONFIG;
if (!rawConfig) throw new Error('RESPLITE_BENCH_CONFIG is required');

const config = JSON.parse(rawConfig);
startServer({
  ...config,
  gracefulShutdown: true,
});
