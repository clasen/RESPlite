/**
 * MONITOR - switch the current connection to monitor mode.
 */

import type { CommandReply } from '../types.ts';

export function handleMonitor(args: Buffer[]): CommandReply {
  if (args && args.length !== 0) {
    return { error: 'ERR wrong number of arguments for \'MONITOR\' command' };
  }
  return { simple: 'OK' };
}
