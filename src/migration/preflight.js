/**
 * Preflight check: estimate key count, type distribution, notify-keyspace-events (SPEC_F §F.9 Step 0).
 */

/**
 * @param {import('redis').RedisClientType} redisClient
 * @returns {Promise<{ keyCountEstimate: number; typeDistribution: Record<string, number>; notifyKeyspaceEvents: string | null; recommended: { scan_count: number; max_concurrency: number; max_rps: number } }>}
 */
export async function runPreflight(redisClient) {
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

  let notifyKeyspaceEvents = null;
  try {
    const config = await redisClient.configGet('notify-keyspace-events');
    notifyKeyspaceEvents = config && typeof config === 'object' ? config['notify-keyspace-events'] : null;
    if (typeof notifyKeyspaceEvents !== 'string') notifyKeyspaceEvents = null;
  } catch (_) {
    notifyKeyspaceEvents = null;
  }

  const recommended = {
    scan_count: 1000,
    max_concurrency: 32,
    max_rps: keyCountEstimate > 100000 ? 2000 : 1000,
  };

  return {
    keyCountEstimate,
    typeDistribution,
    notifyKeyspaceEvents,
    recommended,
  };
}
