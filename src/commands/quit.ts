/**
 * QUIT - close connection. Handler returns special signal.
 */

import type { CommandReply } from '../types.ts';

export function handleQuit(): CommandReply {
  return { quit: true };
}
