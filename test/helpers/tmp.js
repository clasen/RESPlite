/**
 * Temporary database path for tests.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let counter = 0;

export function tmpDbPath() {
  const dir = path.join(__dirname, '..', 'tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return path.join(dir, `test-${process.pid}-${Date.now()}-${++counter}.db`);
}
