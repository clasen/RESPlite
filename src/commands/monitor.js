/**
 * MONITOR - switch the current connection to monitor mode.
 */

export function handleMonitor(args) {
  if (args && args.length !== 0) {
    return { error: 'ERR wrong number of arguments for \'MONITOR\' command' };
  }
  return { simple: 'OK' };
}
