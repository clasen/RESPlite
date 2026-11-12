/**
 * ZMPOP numkeys key [key ...] MIN|MAX [COUNT count]
 */

import { parseMultiPopArguments } from './multi-pop-arguments.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleZmpop(engine: Engine, args: Buffer[]): CommandReply {
  const parsed = parseMultiPopArguments(args, 'ZMPOP', ['MIN', 'MAX']);
  if (parsed.error) return parsed;
  try {
    return engine.zmpop(parsed.keys, parsed.direction, parsed.count);
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
