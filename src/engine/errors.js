/**
 * Redis-like error messages (SPEC section 8.1, 6.7).
 */

export const ERRORS = {
  WRONGTYPE: 'WRONGTYPE Operation against a key holding the wrong kind of value',
  UNSUPPORTED: 'ERR command not supported yet',
};

export function wrongType() {
  return ERRORS.WRONGTYPE;
}

export function unsupported() {
  return ERRORS.UNSUPPORTED;
}

/**
 * Build syntax/numeric error message.
 * @param {string} message
 * @returns {string}
 */
export function err(message) {
  return 'ERR ' + message;
}
