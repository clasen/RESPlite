/**
 * Blocking list waiters: BLPOP/BRPOP (SPEC_E).
 * In-memory wait queues by key; single delivery; wake on LPUSH/RPUSH.
 */

import { asKey } from '../util/buffers.js';

function toMapKey(key) {
  const k = Buffer.isBuffer(key) ? key : asKey(key);
  return k.toString('binary');
}

/**
 * @param {object} engine - RESPlite engine (for lpop/rpop on wake)
 * @param {object} [opts]
 * @param {number} [opts.maxWaitersPerKey=10000]
 * @param {number} [opts.maxTotalWaiters=50000]
 * @param {number} [opts.maxKeysPerWait=128]
 * @param {() => number} [opts.clock=Date.now]
 */
export function createBlockingManager(engine, opts = {}) {
  const maxWaitersPerKey = opts.maxWaitersPerKey ?? 10000;
  const maxTotalWaiters = opts.maxTotalWaiters ?? 50000;
  const maxKeysPerWait = opts.maxKeysPerWait ?? 128;
  const clock = opts.clock ?? (() => Date.now());

  /** @type {Map<string, Array<{ waiter: object }>>} key -> deque of waiter refs */
  const waitersByKey = new Map();
  /** @type {Map<string | number, Set<object>>} connectionId -> waiters for cancel */
  const waitersByConnection = new Map();
  let totalWaiters = 0;

  function removeWaiterFromQueues(waiter) {
    for (const key of waiter.keys) {
      const mapKey = toMapKey(key);
      const q = waitersByKey.get(mapKey);
      if (!q) continue;
      const idx = q.findIndex((ref) => ref.waiter === waiter);
      if (idx !== -1) q.splice(idx, 1);
      if (q.length === 0) waitersByKey.delete(mapKey);
    }
    const connSet = waitersByConnection.get(waiter.connectionId);
    if (connSet) {
      connSet.delete(waiter);
      if (connSet.size === 0) waitersByConnection.delete(waiter.connectionId);
    }
    totalWaiters--;
  }

  /**
   * Try to satisfy one waiter: scan keys in order, pop from first non-empty.
   * @returns {boolean} true if waiter was satisfied and removed
   */
  function tryWake(waiter) {
    if (waiter.completed || waiter.canceled) return false;
    for (const key of waiter.keys) {
      try {
        const val =
          waiter.kind === 'BLPOP'
            ? engine.lpop(key, null)
            : engine.rpop(key, null);
        if (val != null) {
          waiter.completed = true;
          removeWaiterFromQueues(waiter);
          waiter.resolve([key, val]);
          return true;
        }
      } catch (_) {
        // wrong type / missing: skip key
      }
    }
    return false;
  }

  /**
   * Register a blocked client. Keys in order; timeout in seconds (0 = indefinite).
   * @param {Buffer[]} keys
   * @param {'BLPOP'|'BRPOP'} kind
   * @param {number} timeoutSeconds
   * @param {(value: [Buffer, Buffer]|null) => void} resolve - called with [key, element] or null on timeout
   * @param {string|number} connectionId
   * @returns {{ error?: string }}
   */
  function registerWaiter(keys, kind, timeoutSeconds, resolve, connectionId) {
    if (keys.length > maxKeysPerWait) {
      return { error: 'ERR too many keys per blocked command' };
    }
    if (totalWaiters >= maxTotalWaiters) {
      return { error: 'ERR too many blocked clients' };
    }
    for (const k of keys) {
      const mapKey = toMapKey(k);
      const q = waitersByKey.get(mapKey) ?? [];
      if (q.length >= maxWaitersPerKey) {
        return { error: 'ERR too many blocked clients' };
      }
    }

    const deadline =
      timeoutSeconds > 0 ? clock() + timeoutSeconds * 1000 : null;
    const waiter = {
      connectionId,
      kind,
      keys: keys.slice(),
      deadline,
      resolve,
      completed: false,
      canceled: false,
    };

    let timer = null;
    if (deadline != null) {
      timer = setTimeout(() => {
        if (waiter.completed || waiter.canceled) return;
        waiter.completed = true;
        removeWaiterFromQueues(waiter);
        resolve(null);
      }, timeoutSeconds * 1000);
      if (timer.unref) timer.unref();
    }
    waiter.timer = timer;

    totalWaiters++;
    for (const key of keys) {
      const mapKey = toMapKey(key);
      let q = waitersByKey.get(mapKey);
      if (!q) {
        q = [];
        waitersByKey.set(mapKey, q);
      }
      q.push({ waiter });
    }
    let connSet = waitersByConnection.get(connectionId);
    if (!connSet) {
      connSet = new Set();
      waitersByConnection.set(connectionId, connSet);
    }
    connSet.add(waiter);
    return {};
  }

  /**
   * Called after LPUSH/RPUSH on key. Wake at most one waiter (oldest for this key).
   * @param {Buffer|string} key - key that received the push
   */
  function wakeup(key) {
    const mapKey = toMapKey(key);
    const q = waitersByKey.get(mapKey);
    if (!q || q.length === 0) return;
    const ref = q[0];
    const waiter = ref.waiter;
    if (waiter.canceled || waiter.completed) {
      removeWaiterFromQueues(waiter);
      return;
    }
    tryWake(waiter);
  }

  /**
   * On client disconnect: mark waiters canceled and remove from queues.
   * @param {string|number} connectionId
   */
  function cancel(connectionId) {
    const connSet = waitersByConnection.get(connectionId);
    if (!connSet) return;
    for (const waiter of new Set(connSet)) {
      if (waiter.completed) continue;
      waiter.canceled = true;
      if (waiter.timer) {
        clearTimeout(waiter.timer);
        waiter.timer = null;
      }
      removeWaiterFromQueues(waiter);
    }
    waitersByConnection.delete(connectionId);
  }

  return {
    registerWaiter,
    wakeup,
    cancel,
  };
}
