/**
 * Blocking list waiters: BLPOP/BRPOP (SPEC_E).
 * In-memory wait queues by key; single delivery; wake on LPUSH/RPUSH.
 */

import { asKey } from '../util/buffers.ts';

export type BlockKind = 'BLPOP' | 'BRPOP';
export type ConnectionId = string | number;
export type WaiterResolve = (value: [Buffer, Buffer] | null) => void;

/** Engine operations the manager needs to deliver elements on wake. */
export interface BlockingEngine {
  lpop(key: Buffer, count: null): unknown;
  rpop(key: Buffer, count: null): unknown;
}

export interface BlockingManagerOptions {
  maxWaitersPerKey?: number;
  maxTotalWaiters?: number;
  maxKeysPerWait?: number;
  clock?: () => number;
}

interface Waiter {
  connectionId: ConnectionId;
  kind: BlockKind;
  keys: Buffer[];
  deadline: number | null;
  resolve: WaiterResolve;
  completed: boolean;
  canceled: boolean;
  timer?: NodeJS.Timeout | null;
}

function toMapKey(key: Buffer | string): string {
  const k = Buffer.isBuffer(key) ? key : asKey(key);
  return k.toString('binary');
}

/**
 * @param engine - RESPlite engine (for lpop/rpop on wake)
 * @param opts - limits default to 10000 waiters per key, 50000 in total and 128 keys per wait; clock defaults to Date.now
 */
export function createBlockingManager(engine: BlockingEngine, opts: BlockingManagerOptions = {}) {
  const maxWaitersPerKey = opts.maxWaitersPerKey ?? 10000;
  const maxTotalWaiters = opts.maxTotalWaiters ?? 50000;
  const maxKeysPerWait = opts.maxKeysPerWait ?? 128;
  const clock = opts.clock ?? (() => Date.now());

  /** key -> deque of waiter refs */
  const waitersByKey = new Map<string, Array<{ waiter: Waiter }>>();
  /** connectionId -> waiters for cancel */
  const waitersByConnection = new Map<ConnectionId, Set<Waiter>>();
  let totalWaiters = 0;
  let deferredKeys: Map<string, Buffer> | null = null;

  function removeWaiterFromQueues(waiter: Waiter): void {
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
   * @returns true if waiter was satisfied and removed
   */
  function tryWake(waiter: Waiter): boolean {
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
          waiter.resolve([key, val as Buffer]);
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
   * @param resolve - called with [key, element] or null on timeout
   */
  function registerWaiter(
    keys: Buffer[],
    kind: BlockKind,
    timeoutSeconds: number,
    resolve: WaiterResolve,
    connectionId: ConnectionId
  ): { error?: string } {
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
    const waiter: Waiter = {
      connectionId,
      kind,
      keys: keys.slice(),
      deadline,
      resolve,
      completed: false,
      canceled: false,
    };

    let timer: NodeJS.Timeout | null = null;
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
   * @param key - key that received the push
   */
  function wakeup(key: Buffer | string): void {
    const mapKey = toMapKey(key);
    if (deferredKeys) {
      deferredKeys.set(mapKey, Buffer.from(key));
      return;
    }
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
   */
  function cancel(connectionId: ConnectionId): void {
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
    deferWakeups() {
      if (deferredKeys) throw new Error('Wakeups are already deferred');
      deferredKeys = new Map();
    },
    flushWakeups() {
      const pending = deferredKeys!;
      deferredKeys = null;
      for (const [mapKey, key] of pending) {
        let previousLength: number;
        do {
          previousLength = waitersByKey.get(mapKey)?.length ?? 0;
          wakeup(key);
        } while ((waitersByKey.get(mapKey)?.length ?? 0) < previousLength);
      }
    },
    registerWaiter,
    wakeup,
    cancel,
    blockedClientCount: () => waitersByConnection.size,
  };
}

export type BlockingManager = ReturnType<typeof createBlockingManager>;
