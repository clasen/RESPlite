/**
 * Time abstraction for testing and expiration.
 */

/**
 * Default clock using Date.now().
 */
export function defaultClock(): number {
  return Date.now();
}

/**
 * Create a clock that returns a fixed value (for tests).
 */
export function fixedClock(fixedMs: number): () => number {
  return () => fixedMs;
}
