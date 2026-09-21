/** Parse a Redis signed 64-bit integer for indexing and range limits. */
export function parseInteger(raw) {
  const text = String(raw);
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(text) || text.length > 20) {
    throw new Error('ERR value is not an integer or out of range');
  }
  const value = BigInt(text);
  if (value < -9223372036854775808n || value > 9223372036854775807n) {
    throw new Error('ERR value is not an integer or out of range');
  }
  return Number(value);
}
