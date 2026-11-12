import { handleHashExpire } from './hash-field-expiration.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleHpexpire(engine: Engine, args: Buffer[]): CommandReply {
  return handleHashExpire(engine, args, { command: 'HPEXPIRE', absolute: false, milliseconds: true });
}
