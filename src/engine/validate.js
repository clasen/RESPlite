/**
 * Type validation: ensure key has expected type or is missing.
 */

import { KEY_TYPES } from '../storage/sqlite/schema.js';
import { wrongType } from './errors.js';

const TYPE_NAMES = {
  [KEY_TYPES.STRING]: 'string',
  [KEY_TYPES.HASH]: 'hash',
  [KEY_TYPES.SET]: 'set',
  [KEY_TYPES.LIST]: 'list',
  [KEY_TYPES.ZSET]: 'zset',
};

export function expectString(meta) {
  if (meta && meta.type !== KEY_TYPES.STRING) throw new Error(wrongType());
}

export function expectHash(meta) {
  if (meta && meta.type !== KEY_TYPES.HASH) throw new Error(wrongType());
}

export function expectSet(meta) {
  if (meta && meta.type !== KEY_TYPES.SET) throw new Error(wrongType());
}

export function expectList(meta) {
  if (meta && meta.type !== KEY_TYPES.LIST) throw new Error(wrongType());
}

export function expectZset(meta) {
  if (meta && meta.type !== KEY_TYPES.ZSET) throw new Error(wrongType());
}

export function typeName(meta) {
  if (!meta) return 'none';
  return TYPE_NAMES[meta.type] ?? 'none';
}
