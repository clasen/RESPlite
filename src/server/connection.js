/**
 * Single connection: read RESP, dispatch commands, write encoded responses.
 */

import { RESPReader } from '../resp/parser.js';
import { dispatch } from '../commands/registry.js';
import { encode, encodeSimpleString, encodeError } from '../resp/encoder.js';
import { registerMonitorClient, unregisterMonitorClient, broadcastMonitorCommand } from './monitor.js';

let nextConnectionId = 0;

/**
 * @param {import('net').Socket} socket
 * @param {object} engine
 */
export function handleConnection(socket, engine) {
  const reader = new RESPReader();
  const connectionId = ++nextConnectionId;
  const context = {
    connectionId,
    monitorMode: false,
    clientAddress: `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`,
    writeResponse(buf) {
      if (socket.writable) socket.write(buf);
    },
  };

  function writeResult(out) {
    if (out.quit) {
      socket.write(encodeSimpleString('OK'));
      socket.end();
      return true;
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
      if (context.monitorMode && cmd !== 'QUIT') {
        socket.write(encodeError('ERR MONITOR mode only supports QUIT'));
        continue;
      }
      const out = dispatch(engine, argv, context);
      if (cmd === 'MONITOR' && !out.error) {
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
    unregisterMonitorClient(connectionId);
  });

  socket.on('error', () => {});
}
