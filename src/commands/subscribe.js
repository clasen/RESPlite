export function handleSubscribe(args, context) {
  if (!args || args.length === 0) {
    return { error: 'ERR wrong number of arguments for \'SUBSCRIBE\' command' };
  }
  if (!context?.pubSub) {
    return { error: 'ERR Pub/Sub not available in this connection' };
  }
  const pushes = context.pubSub.subscribe(context, args);
  context.pubSubMode = context.pubSub.countFor(context.connectionId) > 0;
  return { pushes };
}
