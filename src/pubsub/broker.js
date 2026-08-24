import { compilePubSubPattern } from './match.js';

function bufferKey(value) {
  return value.toString('base64');
}

function copy(value) {
  return Buffer.from(value);
}

/**
 * Create one ephemeral Pub/Sub namespace for one RESPlite server instance.
 * Messages and subscriptions are intentionally not persisted in SQLite.
 */
export function createPubSubBroker() {
  const channels = new Map();
  const patterns = new Map();
  const byConnection = new Map();

  function stateFor(context) {
    let state = byConnection.get(context.connectionId);
    if (!state) {
      state = {
        context,
        channels: new Set(),
        patterns: new Set(),
      };
      byConnection.set(context.connectionId, state);
    }
    return state;
  }

  function subscriptionCount(state) {
    return state ? state.channels.size + state.patterns.size : 0;
  }

  function requireChannel(key) {
    const entry = channels.get(key);
    if (!entry) throw new Error('Pub/Sub channel registry invariant violated');
    return entry;
  }

  function requirePattern(key) {
    const entry = patterns.get(key);
    if (!entry) throw new Error('Pub/Sub pattern registry invariant violated');
    return entry;
  }

  function subscribe(context, requestedChannels) {
    const state = stateFor(context);
    const pushes = [];
    for (const requested of requestedChannels) {
      const key = bufferKey(requested);
      if (!state.channels.has(key)) {
        let entry = channels.get(key);
        if (!entry) {
          entry = { channel: copy(requested), subscribers: new Map() };
          channels.set(key, entry);
        }
        entry.subscribers.set(context.connectionId, context);
        state.channels.add(key);
      }
      pushes.push(['subscribe', copy(requested), subscriptionCount(state)]);
    }
    return pushes;
  }

  function unsubscribeOne(state, requested) {
    const key = bufferKey(requested);
    if (!state?.channels.has(key)) return;
    state.channels.delete(key);
    const entry = requireChannel(key);
    entry.subscribers.delete(state.context.connectionId);
    if (entry.subscribers.size === 0) channels.delete(key);
  }

  function unsubscribe(context, requestedChannels) {
    const state = stateFor(context);
    const pushes = [];
    if (requestedChannels.length === 0) {
      if (state.channels.size === 0) {
        pushes.push(['unsubscribe', null, subscriptionCount(state)]);
      } else {
        for (const key of Array.from(state.channels)) {
          const channel = requireChannel(key).channel;
          unsubscribeOne(state, channel);
          pushes.push(['unsubscribe', copy(channel), subscriptionCount(state)]);
        }
      }
    } else {
      for (const requested of requestedChannels) {
        unsubscribeOne(state, requested);
        pushes.push(['unsubscribe', copy(requested), subscriptionCount(state)]);
      }
    }
    removeEmptyState(state);
    return pushes;
  }

  function psubscribe(context, requestedPatterns) {
    const state = stateFor(context);
    const pushes = [];
    for (const requested of requestedPatterns) {
      const key = bufferKey(requested);
      if (!state.patterns.has(key)) {
        let entry = patterns.get(key);
        if (!entry) {
          entry = {
            pattern: copy(requested),
            matches: compilePubSubPattern(requested),
            subscribers: new Map(),
          };
          patterns.set(key, entry);
        }
        entry.subscribers.set(context.connectionId, context);
        state.patterns.add(key);
      }
      pushes.push(['psubscribe', copy(requested), subscriptionCount(state)]);
    }
    return pushes;
  }

  function punsubscribeOne(state, requested) {
    const key = bufferKey(requested);
    if (!state?.patterns.has(key)) return;
    state.patterns.delete(key);
    const entry = requirePattern(key);
    entry.subscribers.delete(state.context.connectionId);
    if (entry.subscribers.size === 0) patterns.delete(key);
  }

  function punsubscribe(context, requestedPatterns) {
    const state = stateFor(context);
    const pushes = [];
    if (requestedPatterns.length === 0) {
      if (state.patterns.size === 0) {
        pushes.push(['punsubscribe', null, subscriptionCount(state)]);
      } else {
        for (const key of Array.from(state.patterns)) {
          const pattern = requirePattern(key).pattern;
          punsubscribeOne(state, pattern);
          pushes.push(['punsubscribe', copy(pattern), subscriptionCount(state)]);
        }
      }
    } else {
      for (const requested of requestedPatterns) {
        punsubscribeOne(state, requested);
        pushes.push(['punsubscribe', copy(requested), subscriptionCount(state)]);
      }
    }
    removeEmptyState(state);
    return pushes;
  }

  function removeEmptyState(state) {
    if (state && subscriptionCount(state) === 0) {
      byConnection.delete(state.context.connectionId);
    }
  }

  function publish(channel, message) {
    let receivers = 0;
    const direct = channels.get(bufferKey(channel));
    if (direct) {
      for (const context of direct.subscribers.values()) {
        context.writePubSub(['message', copy(channel), copy(message)]);
        receivers++;
      }
    }
    for (const entry of patterns.values()) {
      if (!entry.matches(channel)) continue;
      for (const context of entry.subscribers.values()) {
        context.writePubSub(['pmessage', copy(entry.pattern), copy(channel), copy(message)]);
        receivers++;
      }
    }
    return receivers;
  }

  function disconnect(connectionId) {
    const state = byConnection.get(connectionId);
    if (!state) return;
    for (const key of Array.from(state.channels)) {
      unsubscribeOne(state, requireChannel(key).channel);
    }
    for (const key of Array.from(state.patterns)) {
      punsubscribeOne(state, requirePattern(key).pattern);
    }
    byConnection.delete(connectionId);
  }

  function activeChannels(pattern = null) {
    const out = [];
    const matches = pattern ? compilePubSubPattern(pattern) : null;
    for (const entry of channels.values()) {
      if (matches && !matches(entry.channel)) continue;
      out.push(copy(entry.channel));
    }
    return out;
  }

  function numsub(requestedChannels) {
    const out = [];
    for (const channel of requestedChannels) {
      out.push(copy(channel), channels.get(bufferKey(channel))?.subscribers.size ?? 0);
    }
    return out;
  }

  function countFor(connectionId) {
    return subscriptionCount(byConnection.get(connectionId));
  }

  return {
    subscribe,
    unsubscribe,
    psubscribe,
    punsubscribe,
    publish,
    disconnect,
    activeChannels,
    numsub,
    numpat: () => patterns.size,
    countFor,
  };
}
