/**
 * Match Redis glob syntax against binary-safe values.
 * Supports *, ?, character classes/ranges, ^ negation, and backslash escaping.
 * @param {Buffer|string} value
 * @param {Buffer|string} pattern
 * @returns {boolean}
 */
export function matchPattern(value, pattern) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const glob = Buffer.isBuffer(pattern) ? pattern : Buffer.from(String(pattern), 'utf8');
  const memo = new Map();

  function matchClass(byte, start) {
    let index = start + 1;
    let negate = false;
    if (glob[index] === 94) {
      negate = true;
      index++;
    }

    let matched = false;
    let hasClosingBracket = false;
    while (index < glob.length) {
      if (glob[index] === 93) {
        hasClosingBracket = true;
        index++;
        break;
      }
      let first = glob[index++];
      if (first === 92 && index < glob.length) first = glob[index++];
      let last = first;
      if (index + 1 < glob.length && glob[index] === 45 && glob[index + 1] !== 93) {
        index++;
        last = glob[index++];
        if (last === 92 && index < glob.length) last = glob[index++];
      }
      const low = Math.min(first, last);
      const high = Math.max(first, last);
      if (byte >= low && byte <= high) matched = true;
    }
    if (!hasClosingBracket) return null;
    return { matched: negate ? !matched : matched, next: index };
  }

  function visit(inputIndex, patternIndex) {
    const key = `${inputIndex}:${patternIndex}`;
    if (memo.has(key)) return memo.get(key);

    let result;
    if (patternIndex === glob.length) {
      result = inputIndex === input.length;
    } else if (glob[patternIndex] === 42) {
      while (glob[patternIndex + 1] === 42) patternIndex++;
      result = visit(inputIndex, patternIndex + 1)
        || (inputIndex < input.length && visit(inputIndex + 1, patternIndex));
    } else if (inputIndex === input.length) {
      result = false;
    } else if (glob[patternIndex] === 63) {
      result = visit(inputIndex + 1, patternIndex + 1);
    } else if (glob[patternIndex] === 91) {
      const characterClass = matchClass(input[inputIndex], patternIndex);
      result = characterClass == null
        ? input[inputIndex] === glob[patternIndex] && visit(inputIndex + 1, patternIndex + 1)
        : characterClass.matched && visit(inputIndex + 1, characterClass.next);
    } else if (glob[patternIndex] === 92 && patternIndex + 1 < glob.length) {
      result = input[inputIndex] === glob[patternIndex + 1] && visit(inputIndex + 1, patternIndex + 2);
    } else {
      result = input[inputIndex] === glob[patternIndex] && visit(inputIndex + 1, patternIndex + 1);
    }

    memo.set(key, result);
    return result;
  }

  return visit(0, 0);
}

/**
 * Check if key matches a glob pattern.
 * @param {Buffer} key
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchKey(key, pattern) {
  if (!pattern || pattern === '*') return true;
  return matchPattern(key, pattern);
}
