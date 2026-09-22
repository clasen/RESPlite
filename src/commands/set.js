/**
 * SET key value [NX | XX] [GET] [EX seconds | PX milliseconds | EXAT unix-seconds | PXAT unix-milliseconds | KEEPTTL]
 * Options accept any order and are case-insensitive. NX and XX exclude each other, an
 * expiry option excludes the other expiry forms, and repeating the same option keeps
 * the last value, matching Redis.
 */

import { parseInteger64 } from '../util/integers.js';

const EXPIRY_OPTIONS = new Set(['EX', 'PX', 'EXAT', 'PXAT']);

function syntaxError() {
  return { error: 'ERR syntax error' };
}

export function handleSet(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'set\' command' };
  }
  const key = args[0];
  const value = args[1];
  const options = {};
  let expiryOption = null;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i].toString().toUpperCase();
    if (arg === 'NX' || arg === 'XX') {
      if (options[arg === 'NX' ? 'xx' : 'nx']) return syntaxError();
      options[arg.toLowerCase()] = true;
    } else if (arg === 'GET') {
      options.get = true;
    } else if (arg === 'KEEPTTL' || EXPIRY_OPTIONS.has(arg)) {
      if (expiryOption && expiryOption !== arg) return syntaxError();
      if (arg === 'KEEPTTL') {
        expiryOption = arg;
        options.keepttl = true;
        continue;
      }
      const raw = args[i + 1];
      if (raw == null) return syntaxError();
      expiryOption = arg;
      options[arg.toLowerCase()] = raw;
      i++;
    } else {
      return syntaxError();
    }
  }
  try {
    if (EXPIRY_OPTIONS.has(expiryOption)) {
      options[expiryOption.toLowerCase()] = parseInteger64(options[expiryOption.toLowerCase()]);
    }
    const { written, previous } = engine.set(key, value, options);
    if (options.get) return previous;
    return written ? { simple: 'OK' } : null;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
