export function handlePunsubscribe(args, context) {
  if (!context?.pubSub) {
    return { error: 'ERR Pub/Sub not available in this connection' };
  }
  const pushes = context.pubSub.punsubscribe(context, args ?? []);
  context.pubSubMode = context.pubSub.countFor(context.connectionId) > 0;
  return { pushes };
}
