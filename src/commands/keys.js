/**
 * KEYS pattern - return all keys matching the glob pattern.
 */

function escapeRegexChar(ch) {
  return /[\\^$+?.()|{}]/.test(ch) ? '\\' + ch : ch;
}

function globToRegExp(glob) {
  let out = '^';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '\\') {
      if (i + 1 < glob.length) {
        out += escapeRegexChar(glob[i + 1]);
        i += 2;
      } else {
        out += '\\\\';
        i += 1;
      }
      continue;
    }
    if (ch === '*') {
      out += '.*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '.';
      i += 1;
      continue;
    }
    out += escapeRegexChar(ch);
    i += 1;
  }
  out += '$';
  return new RegExp(out);
}

export function handleKeys(engine, args) {
  if (!args || args.length !== 1) {
    return { error: 'ERR wrong number of arguments for \'KEYS\' command' };
  }
  const pattern = args[0].toString('utf8');
  const matcher = globToRegExp(pattern);
  const seen = new Set();
  const matches = [];

  let cursor = '0';
  do {
    const scanned = engine.scan(cursor, { count: 256 });
    const keys = scanned.keys ?? [];
    for (const key of keys) {
      if (!Buffer.isBuffer(key)) continue;
      const hex = key.toString('hex');
      if (seen.has(hex)) continue;
      seen.add(hex);
      if (engine.type(key) === 'none') continue;
      const keyText = key.toString('utf8');
      if (matcher.test(keyText)) matches.push(key);
    }
    cursor = String(scanned.cursor);
  } while (cursor !== '0');

  return matches;
}
