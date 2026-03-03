/**
 * Single connection: read RESP, dispatch commands, write encoded responses.
 */

import { RESPReader } from '../resp/parser.js';
import { dispatch } from '../commands/registry.js';
import { encode, encodeSimpleString, encodeError } from '../resp/encoder.js';

/**
 * @param {import('net').Socket} socket
 * @param {object} engine
 */
export function handleConnection(socket, engine) {
  const reader = new RESPReader();

  socket.on('data', (chunk) => {
    reader.feed(chunk);
    const commands = reader.parseCommands();
    for (const argv of commands) {
      const out = dispatch(engine, argv);
      if (out.quit) {
        socket.write(encodeSimpleString('OK'));
        socket.end();
        return;
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
    }
  });

  socket.on('error', () => {});
}
