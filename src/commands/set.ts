/**
 * SET key value [NX | XX] [GET] [EX seconds | PX milliseconds | EXAT unix-seconds | PXAT unix-milliseconds | KEEPTTL]
 * Options accept any order and are case-insensitive. NX and XX exclude each other, an
 * expiry option excludes the other expiry forms, and repeating the same option keeps
 * the last value, matching Redis.
 */

import { parseInteger64 } from '../util/integers.ts';
import type { CommandReply, Engine } from '../types.ts';

const EXPIRY_OPTIONS = new Set<string | null>(['EX', 'PX', 'EXAT', 'PXAT']);

type ExpiryKey = 'ex' | 'px' | 'exat' | 'pxat';

interface SetOptions {
  nx?: boolean;
  xx?: boolean;
  get?: boolean;
  keepttl?: boolean;
  ex?: Buffer | bigint;
  px?: Buffer | bigint;
  exat?: Buffer | bigint;
  pxat?: Buffer | bigint;
}

function syntaxError(): { error: string } {
  return { error: 'ERR syntax error' };
}

export function handleSet(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'set\' command' };
  }
  const key = args[0];
  const value = args[1];
  const options: SetOptions = {};
  let expiryOption: string | null = null;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i].toString().toUpperCase();
    if (arg === 'NX' || arg === 'XX') {
      if (options[arg === 'NX' ? 'xx' : 'nx']) return syntaxError();
      options[arg.toLowerCase() as 'nx' | 'xx'] = true;
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
      options[arg.toLowerCase() as ExpiryKey] = raw;
      i++;
    } else {
      return syntaxError();
    }
  }
  try {
    if (EXPIRY_OPTIONS.has(expiryOption)) {
      options[expiryOption!.toLowerCase() as ExpiryKey] = parseInteger64(options[expiryOption!.toLowerCase() as ExpiryKey]!);
    }
    const { written, previous } = engine.set(key, value, options);
    if (options.get) return previous;
    return written ? { simple: 'OK' } : null;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
