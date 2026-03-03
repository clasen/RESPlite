/**
 * Preflight check: estimate key count, type distribution, notify-keyspace-events (SPEC_F §F.9 Step 0).
 */

const KEYSPACE_PARAM = 'notify-keyspace-events';

/**
 * Read the current `notify-keyspace-events` value from Redis.
 * Uses raw sendCommand so it works even if the CONFIG command has been renamed.
 *
 * @param {import('redis').RedisClientType} redisClient
 * @param {string} [configCommand='CONFIG']
 * @returns {Promise<{ value: string | null; available: boolean }>}
 *   `available: false` when the command is disabled or renamed and the default name fails.
 */
export async function readKeyspaceEvents(redisClient, configCommand = 'CONFIG') {
  try {
    const raw = await redisClient.sendCommand([configCommand, 'GET', KEYSPACE_PARAM]);
    // Redis returns a flat array ['notify-keyspace-events', '<value>']
    if (Array.isArray(raw) && raw.length >= 2) {
      return { value: String(raw[1] ?? ''), available: true };
    }
    // redis@4 may return an object { 'notify-keyspace-events': '<value>' }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const v = raw[KEYSPACE_PARAM];
      return { value: typeof v === 'string' ? v : null, available: true };
    }
    return { value: null, available: true };
  } catch (_) {
    return { value: null, available: false };
  }
}

/**
 * Set `notify-keyspace-events` to `value` on Redis.
 * Optionally merges the new flags into the existing value instead of overwriting.
 *
 * @param {import('redis').RedisClientType} redisClient
 * @param {string} value - Flags to apply (e.g. `'Kgxe'`).
 * @param {{ configCommand?: string; merge?: boolean }} [options]
 * @returns {Promise<{ ok: boolean; previous: string | null; applied: string; error?: string }>}
 */
export async function setKeyspaceEvents(redisClient, value, { configCommand = 'CONFIG', merge = true } = {}) {
  const { value: previous, available } = await readKeyspaceEvents(redisClient, configCommand);

  if (!available) {
    return {
      ok: false,
      previous: null,
      applied: value,
      error: `CONFIG command not available (it may have been renamed). ` +
             `Use the configCommand option to supply the correct name, ` +
             `or set notify-keyspace-events manually: ${configCommand} SET ${KEYSPACE_PARAM} ${value}`,
    };
  }

  const applied = merge && previous ? mergeFlags(previous, value) : value;

  try {
    await redisClient.sendCommand([configCommand, 'SET', KEYSPACE_PARAM, applied]);
    return { ok: true, previous, applied };
  } catch (err) {
    return { ok: false, previous, applied, error: err.message };
  }
}

/**
 * Merge two Redis notify-keyspace-events flag strings.
 * Preserves all flags from both; result is sorted for readability.
 * @param {string} existing
 * @param {string} required
 * @returns {string}
 */
function mergeFlags(existing, required) {
  const merged = new Set([...existing, ...required]);
  return [...merged].sort().join('');
}

/**
 * @param {import('redis').RedisClientType} redisClient
 * @param {{ configCommand?: string }} [options]
 * @returns {Promise<{ keyCountEstimate: number; typeDistribution: Record<string, number>; notifyKeyspaceEvents: string | null; configCommandAvailable: boolean; recommended: { scan_count: number; max_concurrency: number; max_rps: number } }>}
 */
export async function runPreflight(redisClient, { configCommand = 'CONFIG' } = {}) {
  let keyCountEstimate = 0;
  try {
    keyCountEstimate = await redisClient.dbSize();
  } catch (_) {
    keyCountEstimate = 0;
  }

  const typeDistribution = { string: 0, hash: 0, set: 0, list: 0, zset: 0, other: 0 };
  const sampleSize = Math.min(1000, Math.max(100, Math.floor(keyCountEstimate / 10)));
  let cursor = 0;
  let sampled = 0;

  if (keyCountEstimate > 0) {
    do {
      const result = await redisClient.scan(cursor, { COUNT: 200 });
      const keys = Array.isArray(result) ? result[1] : (result?.keys || []);
      cursor = Array.isArray(result) ? parseInt(result[0], 10) : (result?.cursor ?? 0);

      for (const key of keys) {
        if (sampled >= sampleSize) break;
        try {
          const type = (await redisClient.type(key)).toLowerCase();
          if (typeDistribution[type] !== undefined) typeDistribution[type]++;
          else typeDistribution.other++;
          sampled++;
        } catch (_) {}
      }
      if (sampled >= sampleSize) break;
    } while (cursor !== 0);
  }

  const { value: notifyKeyspaceEvents, available: configCommandAvailable } =
    await readKeyspaceEvents(redisClient, configCommand);

  const recommended = {
    scan_count: 1000,
    max_concurrency: 32,
    max_rps: keyCountEstimate > 100000 ? 2000 : 1000,
  };

  return {
    keyCountEstimate,
    typeDistribution,
    notifyKeyspaceEvents,
    configCommandAvailable,
    recommended,
  };
}
