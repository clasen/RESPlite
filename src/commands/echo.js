/**
 * ECHO message - returns message as bulk string.
 */

export function handleEcho(args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'ECHO\' command' };
  }
  return args[0]; // Buffer; encoder will send as bulk
}
