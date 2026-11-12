/**
 * LRU cache with max entries and max bytes limits.
 * Entry: { kind, version, expiresAt, value } per SPEC 12.3.
 *
 * Recency is a doubly linked list (head = most recent) indexed by a Map, so
 * hits and evictions are O(1) and never churn the Map's insertion order.
 * Cached values are replaced, never mutated, so each node stores its size.
 */

export interface LRUOptions {
  maxEntries?: number;
  maxBytes?: number;
}

interface LRUNode<E> {
  key: string;
  entry: E;
  size: number;
  prev: LRUNode<E> | null;
  next: LRUNode<E> | null;
}

export function createLRU<E extends { value: unknown }>(opts: LRUOptions = {}) {
  const maxEntries = opts.maxEntries ?? 50000;
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  const map = new Map<string, LRUNode<E>>();
  let head: LRUNode<E> | null = null;
  let tail: LRUNode<E> | null = null;
  let totalBytes = 0;
  let hits = 0;
  let misses = 0;

  function estimateSize(value: unknown): number {
    if (value == null) return 0;
    if (Buffer.isBuffer(value)) return value.length;
    if (typeof value === 'string') return value.length * 2;
    if (Array.isArray(value)) return value.reduce((s: number, v: unknown) => s + estimateSize(v), 0);
    if (value instanceof Map) {
      let s = 0;
      for (const [k, v] of value) s += estimateSize(k) + estimateSize(v);
      return s;
    }
    return 8;
  }

  function unlink(node: LRUNode<E>): void {
    if (node.prev) node.prev.next = node.next;
    else head = node.next;
    if (node.next) node.next.prev = node.prev;
    else tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  function pushFront(node: LRUNode<E>): void {
    node.next = head;
    if (head) head.prev = node;
    head = node;
    if (!tail) tail = node;
  }

  function remove(node: LRUNode<E>): void {
    unlink(node);
    map.delete(node.key);
    totalBytes -= node.size;
  }

  function get(key: string): E | null {
    const node = map.get(key);
    if (!node) {
      misses++;
      return null;
    }
    hits++;
    if (node !== head) {
      unlink(node);
      pushFront(node);
    }
    return node.entry;
  }

  function set(key: string, entry: E): void {
    const size = estimateSize(entry.value);
    const old = map.get(key);
    // Remove replacements first so an update does not count as an extra entry.
    if (old) remove(old);

    // A value that cannot fit must not flush unrelated hot entries.
    if (maxEntries <= 0 || maxBytes <= 0 || size > maxBytes) return;

    while (tail && (map.size >= maxEntries || totalBytes + size > maxBytes)) {
      remove(tail);
    }
    const node: LRUNode<E> = { key, entry, size, prev: null, next: null };
    pushFront(node);
    map.set(key, node);
    totalBytes += size;
  }

  function del(key: string): void {
    const node = map.get(key);
    if (node) remove(node);
  }

  function clear(): void {
    map.clear();
    head = null;
    tail = null;
    totalBytes = 0;
  }

  return {
    get,
    set,
    del,
    clear,
    get stats() {
      return {
        entries: map.size,
        bytes: totalBytes,
        hits,
        misses,
        hitRatio: hits + misses > 0 ? hits / (hits + misses) : 0,
      };
    },
  };
}
