import { handleHashExpire } from './hash-field-expiration.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleHexpireat(engine: Engine, args: Buffer[]): CommandReply {
  return handleHashExpire(engine, args, { command: 'HEXPIREAT', absolute: true, milliseconds: false });
}
