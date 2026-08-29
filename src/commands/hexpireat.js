import { handleHashExpire } from './hash-field-expiration.js';

export function handleHexpireat(engine, args) {
  return handleHashExpire(engine, args, { command: 'HEXPIREAT', absolute: true, milliseconds: false });
}
