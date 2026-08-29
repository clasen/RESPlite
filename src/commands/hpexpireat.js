import { handleHashExpire } from './hash-field-expiration.js';

export function handleHpexpireat(engine, args) {
  return handleHashExpire(engine, args, { command: 'HPEXPIREAT', absolute: true, milliseconds: true });
}
