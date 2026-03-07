#!/usr/bin/env node
/**
 * Quick smoke test for `node:readline/promises` `createInterface()`.
 *
 * Usage:
 *   node scripts/create-interface-smoke.js
 *
 * You can also pipe answers:
 *   printf 'Martin\n\n' | node scripts/create-interface-smoke.js
 */

import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const name = await rl.question('Escribe tu nombre y pulsa Enter: ');
    console.log(`Hola${name ? `, ${name}` : ''}.`);

    await rl.question('Pulsa Enter para simular el cutover final...');
    console.log('Continuando despues del Enter.');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error('Fallo la prueba de createInterface:', error);
  process.exitCode = 1;
});
