/**
 * BLPOP key [key ...] timeout
 * Block until one of the keys has an element, or timeout (seconds). timeout 0 = block indefinitely.
 * Returns [key, element] on success, nil on timeout.
 */

import { ERRORS } from '../engine/errors.js';

function parseTimeout(arg) {
  if (arg == null || arg === '') return null;
  const s = Buffer.isBuffer(arg) ? arg.toString('utf8') : String(arg);
  const n = parseInt(s, 10);
  if (Number.isNaN(n) || s.trim() === '' || String(n) !== s.trim()) return null;
  return n;
}

export function handleBlpop(engine, args, context) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'BLPOP\' command' };
  }
  const timeoutArg = args[args.length - 1];
  const timeoutSeconds = parseTimeout(timeoutArg);
  if (timeoutSeconds === null || timeoutSeconds < 0) {
    return { error: 'ERR timeout is not an integer or out of range' };
  }
  const keys = args.slice(0, -1);

  try {
    for (const key of keys) {
      const t = engine.type(key);
      if (t !== 'none' && t !== 'list') {
        return { error: ERRORS.WRONGTYPE };
      }
    }
    for (const key of keys) {
      const val = engine.lpop(key, null);
      if (val != null) {
        return [key, val];
      }
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }

  if (!context) {
    return { error: 'ERR blocking not supported in this context' };
  }
  return { block: { keys, kind: 'BLPOP', timeoutSeconds } };
}
