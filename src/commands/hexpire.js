/**
 * HEXPIRE key seconds [NX | XX | GT | LT] FIELDS numfields field [field ...]
 * Redis 7.4 per-field TTL. Returns array of integers (-2/0/1/2) per field.
 */

import { handleHashExpire } from './hash-field-expiration.js';

export function handleHexpire(engine, args) {
  return handleHashExpire(engine, args, { command: 'HEXPIRE', absolute: false, milliseconds: false });
}
