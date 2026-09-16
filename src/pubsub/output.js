import { pubSubConfig } from './config.js';

export function createPubSubOutput(socket) {
  let queue = [];
  let head = 0;
  let queuedBytes = 0;
  let blocked = false;
  let ending = false;

  function clear() {
    queue = [];
    head = 0;
    queuedBytes = 0;
    socket.off('drain', drain);
  }

  function drain() {
    if (socket.destroyed || !socket.writable) return;
    blocked = false;
    while (head < queue.length) {
      const buffer = queue[head];
      queue[head++] = null;
      queuedBytes -= buffer.length;
      blocked = !socket.write(buffer);
      if (blocked) break;
    }
    if (head === queue.length) {
      queue = [];
      head = 0;
      if (ending) socket.end();
    } else if (head >= queue.length / 2) {
      queue = queue.slice(head);
      head = 0;
    }
  }

  socket.on('drain', drain);
  socket.once('close', clear);

  return {
    write(buffer) {
      if (ending || socket.destroyed || !socket.writable) return false;
      if (queuedBytes + socket.writableLength + buffer.length > pubSubConfig.maxPendingBytes) {
        const error = new Error('Pub/Sub pending output limit exceeded');
        error.code = 'PUBSUB_OUTPUT_LIMIT';
        clear();
        socket.destroy(error);
        return false;
      }
      if (blocked) {
        queue.push(buffer);
        queuedBytes += buffer.length;
      } else {
        blocked = !socket.write(buffer);
      }
      return true;
    },
    end() {
      ending = true;
      if (head === queue.length && !socket.destroyed) socket.end();
    },
  };
}
