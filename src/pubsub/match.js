/**
 * Compile a binary Redis-style glob pattern. Matching uses iterative star
 * backtracking so untrusted patterns cannot exhaust the JavaScript call stack.
 *
 * @param {Buffer} pattern
 * @returns {(value: Buffer) => boolean}
 */
export function compilePubSubPattern(pattern) {
  const tokens = tokenize(pattern);

  return (value) => {
    let tokenIndex = 0;
    let valueIndex = 0;
    let starIndex = -1;
    let starValueIndex = -1;

    while (valueIndex < value.length) {
      const token = tokens[tokenIndex];
      if (token?.kind === 'star') {
        starIndex = tokenIndex;
        starValueIndex = valueIndex;
        tokenIndex++;
        continue;
      }
      if (token && tokenMatches(token, value[valueIndex])) {
        tokenIndex++;
        valueIndex++;
        continue;
      }
      if (starIndex !== -1) {
        starValueIndex++;
        valueIndex = starValueIndex;
        tokenIndex = starIndex + 1;
        continue;
      }
      return false;
    }

    while (tokens[tokenIndex]?.kind === 'star') tokenIndex++;
    return tokenIndex === tokens.length;
  };
}

/**
 * Match a Redis-style glob pattern against a binary value.
 *
 * @param {Buffer} pattern
 * @param {Buffer} value
 * @returns {boolean}
 */
export function matchPubSubPattern(pattern, value) {
  return compilePubSubPattern(pattern)(value);
}

function tokenize(pattern) {
  const tokens = [];
  let index = 0;

  while (index < pattern.length) {
    const byte = pattern[index];
    if (byte === 0x2a) {
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' });
      index++;
      continue;
    }
    if (byte === 0x3f) {
      tokens.push({ kind: 'any' });
      index++;
      continue;
    }
    if (byte === 0x5b) {
      const characterClass = parseCharacterClass(pattern, index + 1);
      tokens.push(characterClass.token);
      index = characterClass.nextIndex;
      continue;
    }
    if (byte === 0x5c && index + 1 < pattern.length) index++;
    tokens.push({ kind: 'literal', byte: pattern[index] });
    index++;
  }

  return tokens;
}

function parseCharacterClass(pattern, start) {
  let index = start;
  let negate = false;
  const ranges = [];

  if (pattern[index] === 0x5e) {
    negate = true;
    index++;
  }

  while (index < pattern.length && pattern[index] !== 0x5d) {
    const firstResult = readClassByte(pattern, index);
    const first = firstResult.byte;
    index = firstResult.nextIndex;

    if (index < pattern.length && pattern[index] === 0x2d && index + 1 < pattern.length && pattern[index + 1] !== 0x5d) {
      const lastResult = readClassByte(pattern, index + 1);
      ranges.push([Math.min(first, lastResult.byte), Math.max(first, lastResult.byte)]);
      index = lastResult.nextIndex;
    } else {
      ranges.push([first, first]);
    }
  }

  if (index >= pattern.length) {
    return { token: { kind: 'invalid' }, nextIndex: pattern.length };
  }

  return {
    token: { kind: 'class', negate, ranges },
    nextIndex: index + 1,
  };
}

function readClassByte(pattern, index) {
  if (pattern[index] === 0x5c && index + 1 < pattern.length) index++;
  return { byte: pattern[index], nextIndex: index + 1 };
}

function tokenMatches(token, byte) {
  if (token.kind === 'any') return true;
  if (token.kind === 'literal') return token.byte === byte;
  if (token.kind !== 'class') return false;
  const inClass = token.ranges.some(([start, end]) => byte >= start && byte <= end);
  return token.negate ? !inClass : inClass;
}
