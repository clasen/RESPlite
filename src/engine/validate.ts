/**
 * Type validation: ensure key has expected type or is missing.
 */

import { KEY_TYPES } from '../storage/sqlite/schema.ts';
import { wrongType } from './errors.ts';

/** Any key metadata row; only its type is inspected. */
export type TypedMeta = { type: number } | null | undefined;

const TYPE_NAMES: Record<number, string> = {
  [KEY_TYPES.STRING]: 'string',
  [KEY_TYPES.HASH]: 'hash',
  [KEY_TYPES.SET]: 'set',
  [KEY_TYPES.LIST]: 'list',
  [KEY_TYPES.ZSET]: 'zset',
};

export function expectString(meta: TypedMeta): void {
  if (meta && meta.type !== KEY_TYPES.STRING) throw new Error(wrongType());
}

export function expectHash(meta: TypedMeta): void {
  if (meta && meta.type !== KEY_TYPES.HASH) throw new Error(wrongType());
}

export function expectSet(meta: TypedMeta): void {
  if (meta && meta.type !== KEY_TYPES.SET) throw new Error(wrongType());
}

export function expectList(meta: TypedMeta): void {
  if (meta && meta.type !== KEY_TYPES.LIST) throw new Error(wrongType());
}

export function expectZset(meta: TypedMeta): void {
  if (meta && meta.type !== KEY_TYPES.ZSET) throw new Error(wrongType());
}

export function typeName(meta: TypedMeta): string {
  if (!meta) return 'none';
  return TYPE_NAMES[meta.type] ?? 'none';
}
