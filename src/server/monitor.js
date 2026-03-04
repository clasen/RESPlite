/**
 * MONITOR support: track monitor clients and broadcast command traces.
 */

import { encodeSimpleString } from '../resp/encoder.js';

const monitorClients = new Map();

function escapeArg(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function formatCommand(argv) {
  const parts = [];
  for (const arg of argv) {
    const text = Buffer.isBuffer(arg) ? arg.toString('utf8') : String(arg);
    parts.push('"' + escapeArg(text) + '"');
  }
  return parts.join(' ');
}

function timestamp() {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  const micros = String((now % 1000) * 1000).padStart(6, '0');
  return sec + '.' + micros;
}

function sourceLabel(sourceContext) {
  const label = sourceContext && sourceContext.clientAddress ? sourceContext.clientAddress : 'unknown';
  return '[0 ' + label + ']';
}

export function registerMonitorClient(context) {
  if (!context || !context.connectionId) return;
  monitorClients.set(context.connectionId, context);
}

export function unregisterMonitorClient(connectionId) {
  if (!connectionId) return;
  monitorClients.delete(connectionId);
}

export function broadcastMonitorCommand(argv, sourceContext) {
  if (!Array.isArray(argv) || argv.length === 0) return;
  if (monitorClients.size === 0) return;
  const line = timestamp() + ' ' + sourceLabel(sourceContext) + ' ' + formatCommand(argv);
  const payload = encodeSimpleString(line);
  for (const monitor of monitorClients.values()) {
    if (monitor && typeof monitor.writeResponse === 'function') {
      monitor.writeResponse(payload);
    }
  }
}
