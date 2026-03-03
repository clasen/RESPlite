/**
 * Optional logger for diagnostics. No-op by default.
 */

let enabled = false;

export function setLogEnabled(value) {
  enabled = !!value;
}

export function log(level, ...args) {
  if (!enabled) return;
  const prefix = `[RESPLite ${level}]`;
  if (level === 'error') {
    console.error(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}
