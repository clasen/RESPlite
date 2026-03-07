/**
 * SETEX key seconds value - set key to value with expiration in seconds (atomic).
 * Delegates to SET key value EX seconds to avoid duplicating logic.
 */

import * as set from './set.js';

export function handleSetex(engine, args) {
  if (!args || args.length !== 3) {
    return { error: 'ERR wrong number of arguments for \'SETEX\' command' };
  }
  const key = args[0];
  const sec = parseInt(args[1].toString(), 10);
  if (Number.isNaN(sec) || sec < 1) {
    return { error: 'ERR invalid expire time in \'SETEX\'' };
  }
  const value = args[2];
  return set.handleSet(engine, [key, value, Buffer.from('EX'), Buffer.from(String(sec))]);
}
