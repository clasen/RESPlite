/**
 * Redis-like error messages (SPEC section 8.1, 6.7).
 */

export const ERRORS = {
  WRONGTYPE: 'WRONGTYPE Operation against a key holding the wrong kind of value',
  UNSUPPORTED: 'ERR command not supported yet',
};

export function wrongType(): string {
  return ERRORS.WRONGTYPE;
}

export function unsupported(): string {
  return ERRORS.UNSUPPORTED;
}

/**
 * Build syntax/numeric error message.
 */
export function err(message: string): string {
  return 'ERR ' + message;
}
