/** Parse a Redis signed 64-bit integer for indexing and range limits. */
export function parseInteger(raw: Buffer | string | number | bigint): number {
  return Number(parseInteger64(raw));
}

/** Parse without losing precision before expiry arithmetic or SQLite binding. */
export function parseInteger64(raw: Buffer | string | number | bigint): bigint {
  const text = String(raw);
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(text) || text.length > 20) {
    throw new Error('ERR value is not an integer or out of range');
  }
  const value = BigInt(text);
  if (value < -9223372036854775808n || value > 9223372036854775807n) {
    throw new Error('ERR value is not an integer or out of range');
  }
  return value;
}

export function numberIfSafe(value: number | bigint): number | bigint {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}
