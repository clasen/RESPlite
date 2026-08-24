export function handlePsubscribe(args, context) {
  if (!args || args.length === 0) {
    return { error: 'ERR wrong number of arguments for \'PSUBSCRIBE\' command' };
  }
  if (!context?.pubSub) {
    return { error: 'ERR Pub/Sub not available in this connection' };
  }
  const pushes = context.pubSub.psubscribe(context, args);
  context.pubSubMode = context.pubSub.countFor(context.connectionId) > 0;
  return { pushes };
}
