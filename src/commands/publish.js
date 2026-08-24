export function handlePublish(args, context) {
  if (!args || args.length !== 2) {
    return { error: 'ERR wrong number of arguments for \'PUBLISH\' command' };
  }
  if (!context?.pubSub) {
    return { error: 'ERR Pub/Sub not available in this connection' };
  }
  return context.pubSub.publish(args[0], args[1]);
}
