/**
 * SETEX key seconds value - set key to value with expiration in seconds (atomic).
 * Delegates to SET key value EX seconds to avoid duplicating logic.
 */

import * as set from './set.js';

export function handleSetex(engine, args) {
  if (!args || args.length !== 3) {
    return { error: 'ERR wrong number of arguments for \'setex\' command' };
  }
  const key = args[0];
  const value = args[2];
  const result = set.handleSet(engine, [key, value, Buffer.from('EX'), args[1]]);
  if (result?.error) result.error = result.error.replace("'set'", "'setex'");
  return result;
}
