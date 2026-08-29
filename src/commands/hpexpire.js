import { handleHashExpire } from './hash-field-expiration.js';

export function handleHpexpire(engine, args) {
  return handleHashExpire(engine, args, { command: 'HPEXPIRE', absolute: false, milliseconds: true });
}
