/**
 * Time abstraction for testing and expiration.
 */

/**
 * Default clock using Date.now().
 */
export function defaultClock() {
  return Date.now();
}

/**
 * Create a clock that returns a fixed value (for tests).
 * @param {number} fixedMs
 * @returns {() => number}
 */
export function fixedClock(fixedMs) {
  return () => fixedMs;
}
