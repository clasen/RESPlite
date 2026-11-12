import type { CommandContext, CommandReply } from '../types.ts';

export function handlePublish(args: Buffer[], context?: CommandContext): CommandReply {
  if (!args || args.length !== 2) {
    return { error: 'ERR wrong number of arguments for \'PUBLISH\' command' };
  }
  if (!context?.pubSub) {
    return { error: 'ERR Pub/Sub not available in this connection' };
  }
  return context.pubSub.publish(args[0], args[1]);
}
