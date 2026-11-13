/**
 * Single connection: read RESP, dispatch commands, write encoded responses.
 */

import { RESPReader } from '../resp/parser.ts';
import { compileCommandPolicy, dispatch, resolveCommandName } from '../commands/registry.ts';
import { encode, encodeSimpleString, encodeError } from '../resp/encoder.ts';
import { registerMonitorClient, unregisterMonitorClient, broadcastMonitorCommand } from './monitor.ts';
import { createPubSubOutput } from '../pubsub/output.ts';
import { createServerStats } from './stats.ts';
import { connectionConfig } from './config.ts';
import type { Socket } from 'node:net';
import type { CommandPolicy, CompiledCommandPolicy, DispatchResult } from '../commands/registry.ts';
import type { PubSubBroker } from '../pubsub/broker.ts';
import type { ScriptingPlugin } from '../scripting/plugin.ts';
import type { ServerStats } from './stats.ts';
import type { WaiterResolve } from '../blocking/manager.ts';
import type { CommandContext, ConnectionHooks, Engine, RespValue } from '../types.ts';

/** Shared connection services for one server instance. */
export interface ConnectionServices {
  /** Pub/Sub broker shared by every connection of the server. */
  pubSub?: PubSubBroker | null;
  /** Prepared scripting plugin owned by the server. */
  scripting?: ScriptingPlugin | null;
  /** Owner the scripting plugin is attached to; defaults to the engine. */
  scriptingOwner?: object;
  /** Server-wide counters reported by INFO; shared by every connection of the server. */
  stats?: ServerStats;
}

interface ConnectionContext extends CommandContext {
  connectionId: number;
  clientAddress: string;
  monitorMode: boolean;
  pubSubMode: boolean;
  writeResponse: (buffer: Buffer) => boolean;
  writePubSub: (value: RespValue) => boolean;
}

let nextConnectionId = 0;
const PUBSUB_MODE_COMMANDS = new Set<string | null>([
  'PING', 'QUIT', 'SUBSCRIBE', 'UNSUBSCRIBE', 'PSUBSCRIBE', 'PUNSUBSCRIBE',
]);
// Commands that end the connection, block, or reply outside the regular reply stream.
const UNBATCHED_COMMANDS = new Set<string>([
  'QUIT', 'MONITOR', 'BLPOP', 'BRPOP', 'SUBSCRIBE', 'UNSUBSCRIBE', 'PSUBSCRIBE', 'PUNSUBSCRIBE',
]);

/**
 * @param hooks - Optional: onUnknownCommand, onCommandError, onSocketError
 * @param commandPolicy - Optional: command rename/disable policy.
 * @param services - Shared connection services for this server instance.
 */
export function handleConnection(
  socket: Socket,
  engine: Engine,
  hooks: ConnectionHooks = {},
  commandPolicy: CommandPolicy | CompiledCommandPolicy | null = null,
  services: ConnectionServices = {},
): void {
  services.scripting?.attach(services.scriptingOwner ?? engine);
  const reader = new RESPReader();
  const connectionId = ++nextConnectionId;
  const clientAddress = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
  const compiledCommandPolicy = compileCommandPolicy(commandPolicy);
  const serverStats = services.stats ?? createServerStats();
  serverStats.connectedClients++;
  serverStats.totalConnectionsReceived++;
  let pubSubOutput: ReturnType<typeof createPubSubOutput> | undefined;

  let pendingReplies: Buffer[] | null = null;

  function writeResponse(buffer: Buffer): boolean {
    if (pendingReplies) {
      pendingReplies.push(buffer);
      return true;
    }
    if (pubSubOutput) return pubSubOutput.write(buffer);
    if (!socket.writable || socket.destroyed) return false;
    return socket.write(buffer);
  }

  const context: ConnectionContext = {
    connectionId,
    clientAddress,
    localPort: socket.localPort ?? 0,
    serverStats,
    connectionName: null,
    monitorMode: false,
    pubSubMode: false,
    pubSub: services.pubSub ?? null,
    scripting: services.scripting ?? null,
    writeResponse,
    writePubSub(value) {
      pubSubOutput ??= createPubSubOutput(socket);
      return pubSubOutput.write(encode(value));
    },
    onUnknownCommand: hooks.onUnknownCommand,
    onCommandError: hooks.onCommandError,
    onSocketError: hooks.onSocketError,
    commandPolicy: compiledCommandPolicy,
  };

  function writeResult(out: DispatchResult): boolean {
    if (out.quit) {
      writeResponse(encodeSimpleString('OK'));
      if (pubSubOutput) pubSubOutput.end();
      else socket.end();
      return true;
    }
    if (out.pushes) {
      for (const push of out.pushes) {
        if (!context.writePubSub(push)) return true;
      }
      return false;
    }
    let buf;
    if (out.error) {
      buf = encodeError(out.error);
    } else if (out.result && typeof out.result === 'object' && (out.result as { simple: string }).simple !== undefined) {
      buf = encodeSimpleString((out.result as { simple: string }).simple);
    } else if (out.result && typeof out.result === 'object' && (out.result as { error: string }).error !== undefined) {
      buf = encodeError((out.result as { error: string }).error);
    } else {
      buf = encode(out.result as RespValue);
    }
    writeResponse(buf);
    return false;
  }

  // Parsed commands not yet run. Each turn runs them for at most turnBudgetMs and
  // then yields, so one long pipeline cannot starve the other connections.
  let queue: Buffer[][] = [];
  let next = 0;
  let turnScheduled = false;
  let blocked = false;
  let stopped = false;
  let inputPaused = false;

  function pauseInput(): void {
    if (inputPaused) return;
    inputPaused = true;
    socket.pause();
  }

  function commandName(argv: Buffer[]): string | null {
    return argv[0] ? resolveCommandName(argv[0].toString('utf8'), compiledCommandPolicy) : null;
  }

  function isBatchable(argv: Buffer[] | undefined): boolean {
    if (!argv) return false;
    const name = commandName(argv);
    return name === null || !UNBATCHED_COMMANDS.has(name);
  }

  // Consecutive commands that reply inline are committed as one SQLite transaction;
  // commands that write outside the reply stream run one by one.
  function canBatch(): boolean {
    if (queue.length - next < 2 || context.monitorMode || context.pubSubMode || pubSubOutput) return false;
    return isBatchable(queue[next]) && isBatchable(queue[next + 1]);
  }

  function processBatch(deadline: number): void {
    const first = next;
    pendingReplies = [];
    let replies: Buffer[];
    try {
      engine.runBatch(() => processCommands(deadline, true));
      replies = pendingReplies;
    } catch (err) {
      const msg = err && (err as Error).message ? (err as Error).message : String(err);
      const reply = encodeError(msg.startsWith('ERR ') ? msg : 'ERR ' + msg);
      replies = queue.slice(first, next).map(() => reply);
    } finally {
      pendingReplies = null;
    }
    if (!socket.writable || socket.destroyed) return;
    socket.cork();
    for (const reply of replies) socket.write(reply);
    socket.uncork();
  }

  function runTurn(): void {
    turnScheduled = false;
    const deadline = performance.now() + connectionConfig.turnBudgetMs;
    while (next < queue.length && !blocked && !stopped && !socket.destroyed) {
      if (canBatch()) processBatch(deadline);
      else processCommands(deadline, false);
      if (performance.now() >= deadline) break;
    }
    if (stopped || socket.destroyed || next >= queue.length) {
      queue = [];
      next = 0;
      if (inputPaused && !blocked && !stopped && !socket.destroyed) {
        inputPaused = false;
        socket.resume();
      }
      return;
    }
    if (blocked) return;
    // Stop reading while commands are queued so TCP backpressure still applies.
    pauseInput();
    scheduleTurn();
  }

  function scheduleTurn(): void {
    if (turnScheduled) return;
    turnScheduled = true;
    setImmediate(runTurn);
  }

  socket.on('data', (chunk) => {
    reader.feed(chunk);
    const commands = reader.parseCommands();
    if (stopped || commands.length === 0) return;
    for (const argv of commands) queue.push(argv);
    if (!blocked && !turnScheduled) runTurn();
  });

  /**
   * Run queued commands until the deadline. A batch stops before the first command
   * that cannot be batched; outside a batch one command runs per call.
   */
  function processCommands(deadline: number, batched: boolean): void {
    while (next < queue.length) {
      if (socket.destroyed) return;
      const argv = queue[next];
      if (batched && !isBatchable(argv)) return;
      next++;
      const cmd = argv[0] ? argv[0].toString('utf8').toUpperCase() : '';
      const resolvedCommand = resolveCommandName(cmd, compiledCommandPolicy);
      if (context.monitorMode && resolvedCommand !== 'QUIT') {
        writeResponse(encodeError('ERR MONITOR mode only supports QUIT'));
      } else if (context.pubSubMode && !PUBSUB_MODE_COMMANDS.has(resolvedCommand)) {
        writeResponse(encodeError(
          `ERR Can't execute '${cmd.toLowerCase()}': only SUBSCRIBE, UNSUBSCRIBE, PSUBSCRIBE, PUNSUBSCRIBE, PING and QUIT are allowed in this context`
        ));
      } else if (runCommand(argv, resolvedCommand)) {
        return;
      }
      if (!batched || performance.now() >= deadline) return;
    }
  }

  /** @returns true when the connection stops reading commands (QUIT, blocked, closed). */
  function runCommand(argv: Buffer[], resolvedCommand: string | null): boolean {
    serverStats.totalCommandsProcessed++;
    const out = dispatch(engine, argv, context);
    // SQLite rolls back the whole transaction on some errors (e.g. disk full);
    // stop so later commands do not run outside the batch.
    if (pendingReplies && !engine._db.inTransaction) throw new Error('ERR batch transaction was rolled back');
    if (resolvedCommand === 'MONITOR' && !out.error) {
      context.monitorMode = true;
      registerMonitorClient(context);
    } else if (!context.monitorMode) {
      broadcastMonitorCommand(argv, context);
    }
    if (out.quit) {
      stopped = true;
      writeResult(out);
      return true;
    }
    if (out.block) {
      const { keys, kind, timeoutSeconds } = out.block;
      const blockingManager = engine._blockingManager;
      if (!blockingManager) {
        writeResponse(encodeError('ERR blocking not available'));
        return false;
      }
      const resolve: WaiterResolve = (value) => {
        const buf = value === null ? encode(null) : encode(value);
        context.writeResponse(buf);
        blocked = false;
        // Waiters are released from another connection's command; continue on a later turn.
        scheduleTurn();
      };
      const err = blockingManager.registerWaiter(keys, kind, timeoutSeconds, resolve, connectionId);
      if (err.error) {
        writeResponse(encodeError(err.error));
        return false;
      }
      blocked = true;
      pauseInput();
      return true;
    }
    if (writeResult(out)) {
      stopped = true;
      return true;
    }
    return false;
  }

  socket.on('close', () => {
    serverStats.connectedClients--;
    if (engine._blockingManager) engine._blockingManager.cancel(connectionId);
    context.pubSub?.disconnect(connectionId);
    unregisterMonitorClient(connectionId);
  });

  socket.on('error', (err) => {
    context.onSocketError?.({ error: err, clientAddress: context.clientAddress, connectionId: context.connectionId });
  });
}
