/**
 * PING [message] - returns PONG, echoes a message, or emits a Pub/Sub pong.
 */

export function handlePing(args = [], context = null) {
  if (args.length > 1) {
    return { error: 'ERR wrong number of arguments for \'PING\' command' };
  }
  if (context?.pubSubMode) {
    return { pushes: [['pong', args[0] ?? Buffer.alloc(0)]] };
  }
  if (args.length === 1) return Buffer.from(args[0]);
  return { simple: 'PONG' };
}
