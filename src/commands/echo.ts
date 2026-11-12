/**
 * ECHO message - returns message as bulk string.
 */

import type { CommandReply } from '../types.ts';

export function handleEcho(args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'ECHO\' command' };
  }
  return args[0]; // Buffer; encoder will send as bulk
}
