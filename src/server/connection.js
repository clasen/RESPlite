/**
 * Single connection: read RESP, dispatch commands, write encoded responses.
 */

import { RESPReader } from '../resp/parser.js';
import { compileCommandPolicy, dispatch, resolveCommandName } from '../commands/registry.js';
import { encode, encodeSimpleString, encodeError } from '../resp/encoder.js';
import { registerMonitorClient, unregisterMonitorClient, broadcastMonitorCommand } from './monitor.js';

let nextConnectionId = 0;
const PUBSUB_MODE_COMMANDS = new Set([
  'PING', 'QUIT', 'SUBSCRIBE', 'UNSUBSCRIBE', 'PSUBSCRIBE', 'PUNSUBSCRIBE',
]);

/**
 * @param {import('net').Socket} socket
 * @param {object} engine
 * @param {object} [hooks] Optional: onUnknownCommand, onCommandError, onSocketError
 * @param {object|null} [commandPolicy] Optional: command rename/disable policy.
 * @param {{ pubSub?: object }} [services] Shared connection services for this server instance.
 */
export function handleConnection(socket, engine, hooks = {}, commandPolicy = null, services = {}) {
  const reader = new RESPReader();
  const connectionId = ++nextConnectionId;
  const clientAddress = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
  const compiledCommandPolicy = compileCommandPolicy(commandPolicy);
  const context = {
    connectionId,
    clientAddress,
    connectionName: null,
    monitorMode: false,
    pubSubMode: false,
    pubSub: services.pubSub ?? null,
    writeResponse(buf) {
      if (socket.writable) socket.write(buf);
    },
    writePubSub(value) {
      if (!socket.writable) return false;
      const accepted = socket.write(encode(value));
      if (!accepted) socket.destroy();
      return accepted;
    },
    onUnknownCommand: hooks.onUnknownCommand,
    onCommandError: hooks.onCommandError,
    onSocketError: hooks.onSocketError,
    commandPolicy: compiledCommandPolicy,
  };

  function writeResult(out) {
    if (out.quit) {
      socket.write(encodeSimpleString('OK'));
      socket.end();
      return true;
    }
    if (out.pushes) {
      for (const push of out.pushes) {
        if (!socket.writable) return true;
        socket.write(encode(push));
      }
      return false;
    }
    let buf;
    if (out.error) {
      buf = encodeError(out.error);
    } else if (out.result && typeof out.result === 'object' && out.result.simple !== undefined) {
      buf = encodeSimpleString(out.result.simple);
    } else if (out.result && typeof out.result === 'object' && out.result.error !== undefined) {
      buf = encodeError(out.result.error);
    } else {
      buf = encode(out.result);
    }
    socket.write(buf);
    return false;
  }

  socket.on('data', (chunk) => {
    reader.feed(chunk);
    const commands = reader.parseCommands();
    for (const argv of commands) {
      const cmd = argv[0] ? argv[0].toString('utf8').toUpperCase() : '';
      const resolvedCommand = resolveCommandName(cmd, compiledCommandPolicy);
      if (context.monitorMode && resolvedCommand !== 'QUIT') {
        socket.write(encodeError('ERR MONITOR mode only supports QUIT'));
        continue;
      }
      if (context.pubSubMode && !PUBSUB_MODE_COMMANDS.has(resolvedCommand)) {
        socket.write(encodeError(
          `ERR Can't execute '${cmd.toLowerCase()}': only SUBSCRIBE, UNSUBSCRIBE, PSUBSCRIBE, PUNSUBSCRIBE, PING and QUIT are allowed in this context`
        ));
        continue;
      }
      const out = dispatch(engine, argv, context);
      if (resolvedCommand === 'MONITOR' && !out.error) {
        context.monitorMode = true;
        registerMonitorClient(context);
      } else if (!context.monitorMode) {
        broadcastMonitorCommand(argv, context);
      }
      if (out.quit) {
        writeResult(out);
        return;
      }
      if (out.block) {
        const { keys, kind, timeoutSeconds } = out.block;
        const blockingManager = engine._blockingManager;
        if (!blockingManager) {
          socket.write(encodeError('ERR blocking not available'));
          continue;
        }
        const resolve = (value) => {
          const buf = value === null ? encode(null) : encode(value);
          context.writeResponse(buf);
          socket.resume();
        };
        const err = blockingManager.registerWaiter(keys, kind, timeoutSeconds, resolve, connectionId);
        if (err.error) {
          socket.write(encodeError(err.error));
          continue;
        }
        socket.pause();
        return;
      }
      if (writeResult(out)) return;
    }
  });

  socket.on('close', () => {
    if (engine._blockingManager) engine._blockingManager.cancel(connectionId);
    context.pubSub?.disconnect(connectionId);
    unregisterMonitorClient(connectionId);
  });

  socket.on('error', (err) => {
    context.onSocketError?.({ error: err, clientAddress: context.clientAddress, connectionId: context.connectionId });
  });
}
