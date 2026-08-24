function argString(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

export function handlePubsub(args, context) {
  if (!args || args.length === 0) {
    return { error: 'ERR wrong number of arguments for \'PUBSUB\' command' };
  }
  if (!context?.pubSub) {
    return { error: 'ERR Pub/Sub not available in this connection' };
  }

  const subcommand = argString(args[0]).toUpperCase();
  if (subcommand === 'CHANNELS' && args.length <= 2) {
    return context.pubSub.activeChannels(args[1] ?? null);
  }
  if (subcommand === 'NUMSUB') {
    return context.pubSub.numsub(args.slice(1));
  }
  if (subcommand === 'NUMPAT' && args.length === 1) {
    return context.pubSub.numpat();
  }
  return { error: 'ERR unknown subcommand or wrong number of arguments for \'PUBSUB\'. Try PUBSUB HELP.' };
}
