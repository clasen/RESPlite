/**
 * Injectable clock for TTL/expiration tests.
 */

export function defaultClock() {
  return Date.now();
}

export function fixedClock(ms) {
  return () => ms;
}
