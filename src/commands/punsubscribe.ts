import type { CommandContext, CommandReply } from '../types.ts';

export function handlePunsubscribe(args: Buffer[], context?: CommandContext): CommandReply {
  if (!context?.pubSub) {
    return { error: 'ERR Pub/Sub not available in this connection' };
  }
  const pushes = context.pubSub.punsubscribe(context, args ?? []);
  context.pubSubMode = context.pubSub.countFor(context.connectionId) > 0;
  return { pushes };
}
