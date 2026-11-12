/**
 * LMPOP numkeys key [key ...] LEFT|RIGHT [COUNT count]
 */

import { parseMultiPopArguments } from './multi-pop-arguments.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleLmpop(engine: Engine, args: Buffer[]): CommandReply {
  const parsed = parseMultiPopArguments(args, 'LMPOP', ['LEFT', 'RIGHT']);
  if (parsed.error) return parsed;
  try {
    return engine.lmpop(parsed.keys, parsed.direction, parsed.count);
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
