/**
 * QUIT - close connection. Handler returns special signal.
 */

export function handleQuit() {
  return { quit: true };
}
