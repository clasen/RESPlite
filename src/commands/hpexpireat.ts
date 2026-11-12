import { handleHashExpire } from './hash-field-expiration.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleHpexpireat(engine: Engine, args: Buffer[]): CommandReply {
  return handleHashExpire(engine, args, { command: 'HPEXPIREAT', absolute: true, milliseconds: true });
}
