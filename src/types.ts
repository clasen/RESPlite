/**
 * Types shared across the command layer, the connection and the scripting plugin.
 */

import type { Engine } from './engine/engine.ts';
import type { CompiledCommandPolicy } from './commands/registry.ts';
import type { PubSubBroker } from './pubsub/broker.ts';
import type { ScriptingPlugin } from './scripting/plugin.ts';
import type { ServerStats } from './server/stats.ts';

export type { Engine };

/** A value the RESP encoder can serialize. */
export type RespValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Buffer
  | { simple: string }
  | { error: string }
  | RespValue[];

/** Blocking request returned by BLPOP/BRPOP when no element is available. */
export interface BlockRequest {
  keys: Buffer[];
  kind: 'BLPOP' | 'BRPOP';
  timeoutSeconds: number;
}

/** What a command handler returns: a reply, or a control instruction for the connection. */
export type CommandReply =
  | RespValue
  | { quit: true }
  | { block: BlockRequest }
  | { pushes: RespValue[] };

export interface CommandEvent {
  command: string;
  argsCount?: number;
  argv: string[];
  clientAddress: string;
  connectionId: number;
  error?: string;
}

export interface ConnectionHooks {
  onUnknownCommand?: (event: CommandEvent) => void;
  onCommandError?: (event: CommandEvent) => void;
  onSocketError?: (event: { error: Error; clientAddress: string; connectionId: number }) => void;
}

/**
 * Per-connection state handed to command handlers. Scripts dispatch with only
 * `commandPolicy`, so connection fields are optional.
 */
export interface CommandContext extends ConnectionHooks {
  commandPolicy?: CompiledCommandPolicy | null;
  connectionId?: number;
  clientAddress?: string;
  localPort?: number;
  serverStats?: ServerStats;
  connectionName?: string | null;
  monitorMode?: boolean;
  pubSubMode?: boolean;
  pubSub?: PubSubBroker | null;
  scripting?: ScriptingPlugin | null;
  writeResponse?: (buffer: Buffer) => boolean;
  writePubSub?: (value: RespValue) => boolean;
  getCommandNames?: () => string[];
  resolveCommandForIntrospection?: (name: string) => string;
}

export type CommandHandler = (engine: Engine, args: Buffer[], context?: CommandContext) => CommandReply;
