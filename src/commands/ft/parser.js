/**
 * Strict argument parser for FT.* commands (SPEC_D D.13).
 * Args are Buffer[]; decode as UTF-8 and reject invalid UTF-8.
 */

const INDEX_NAME_RE = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const QUERY_SAFE_RE = /^[A-Za-z0-9_\s*]+$/;

function toStr(buf) {
  if (Buffer.isBuffer(buf)) return buf.toString('utf8');
  return String(buf);
}

function isUtf8(buf) {
  if (!Buffer.isBuffer(buf)) return true;
  try {
    buf.toString('utf8');
    return true;
  } catch {
    return false;
  }
}

function expectUtf8(buf, msg = 'ERR invalid field value') {
  if (!isUtf8(buf)) throw new Error(msg);
}

/**
 * Parse FT.CREATE args: IndexName SCHEMA FieldSpec+
 * @param {Buffer[]} args - After command name
 * @returns {{ indexName: string, fields: { name: string, type: string }[] } | { error: string }}
 */
export function parseFtCreate(args) {
  if (!args || args.length < 4) return { error: 'ERR syntax error' };
  expectUtf8(args[0]);
  const indexName = toStr(args[0]).trim();
  if (!INDEX_NAME_RE.test(indexName)) return { error: 'ERR invalid index name' };
  expectUtf8(args[1]);
  if (toStr(args[1]).toUpperCase() !== 'SCHEMA') return { error: 'ERR syntax error' };
  const rest = args.slice(2);
  if (rest.length % 2 !== 0) return { error: 'ERR syntax error' };
  const fields = [];
  for (let i = 0; i < rest.length; i += 2) {
    expectUtf8(rest[i]);
    expectUtf8(rest[i + 1]);
    const name = toStr(rest[i]).trim();
    const type = toStr(rest[i + 1]).toUpperCase();
    if (!FIELD_NAME_RE.test(name)) return { error: 'ERR syntax error' };
    if (type !== 'TEXT') return { error: 'ERR unsupported field type' };
    fields.push({ name, type: 'TEXT' });
  }
  if (fields.length === 0) return { error: 'ERR syntax error' };
  if (!fields.some((f) => f.name === 'payload')) return { error: 'ERR payload field required' };
  return { indexName, fields };
}

/**
 * Parse FT.INFO args: IndexName (exactly one token).
 * @param {Buffer[]} args
 * @returns {{ indexName: string } | { error: string }}
 */
export function parseFtInfo(args) {
  if (!args || args.length !== 1) return { error: 'ERR syntax error' };
  expectUtf8(args[0]);
  const indexName = toStr(args[0]).trim();
  if (!INDEX_NAME_RE.test(indexName)) return { error: 'ERR invalid index name' };
  return { indexName };
}

/**
 * Parse FT.ADD args: IndexName DocId Score [REPLACE] FIELDS FieldValuePair+
 * Field names are validated in handler against schema (after getIndexMeta).
 * @param {Buffer[]} args
 * @returns {{ indexName: string, docId: string, score: number, replace: boolean, fields: Record<string, string> } | { error: string }}
 */
export function parseFtAdd(args) {
  if (!args || args.length < 5) return { error: 'ERR syntax error' };
  expectUtf8(args[0]);
  expectUtf8(args[1]);
  expectUtf8(args[2]);
  const indexName = toStr(args[0]).trim();
  const docId = toStr(args[1]);
  if (!INDEX_NAME_RE.test(indexName)) return { error: 'ERR invalid index name' };
  if (docId.length < 1 || docId.length > 256 || docId.includes('\u0000')) return { error: 'ERR syntax error' };
  const scoreNum = parseFloat(toStr(args[2]));
  if (!Number.isFinite(scoreNum)) return { error: 'ERR invalid score' };
  let i = 3;
  let replace = false;
  while (i < args.length) {
    const tok = toStr(args[i]).toUpperCase();
    if (tok === 'REPLACE') {
      replace = true;
      i += 1;
    } else if (tok === 'FIELDS') {
      break;
    } else {
      return { error: 'ERR syntax error' };
    }
  }
  if (i >= args.length) return { error: 'ERR syntax error' };
  i += 1; // skip FIELDS
  const pairCount = args.length - i;
  if (pairCount % 2 !== 0) return { error: 'ERR syntax error' };
  const fields = {};
  for (; i < args.length; i += 2) {
    expectUtf8(args[i]);
    expectUtf8(args[i + 1]);
    const name = toStr(args[i]).trim();
    const value = toStr(args[i + 1]);
    if (!FIELD_NAME_RE.test(name)) return { error: 'ERR syntax error' };
    fields[name] = value;
  }
  if (Object.keys(fields).length === 0) return { error: 'ERR syntax error' };
  return { indexName, docId, score: scoreNum, replace, fields };
}

/**
 * Parse FT.DEL args: IndexName DocId
 * @param {Buffer[]} args
 * @returns {{ indexName: string, docId: string } | { error: string }}
 */
export function parseFtDel(args) {
  if (!args || args.length !== 2) return { error: 'ERR syntax error' };
  expectUtf8(args[0]);
  expectUtf8(args[1]);
  const indexName = toStr(args[0]).trim();
  const docId = toStr(args[1]);
  if (!INDEX_NAME_RE.test(indexName)) return { error: 'ERR invalid index name' };
  if (docId.length < 1 || docId.length > 256) return { error: 'ERR syntax error' };
  return { indexName, docId };
}

/**
 * Parse FT.SEARCH args: IndexName Query [NOCONTENT] [LIMIT offset count]
 * @param {Buffer[]} args
 * @returns {{ indexName: string, query: string, noContent: boolean, offset: number, count: number } | { error: string }}
 */
export function parseFtSearch(args) {
  if (!args || args.length < 2) return { error: 'ERR syntax error' };
  expectUtf8(args[0]);
  expectUtf8(args[1]);
  const indexName = toStr(args[0]).trim();
  const query = toStr(args[1]);
  if (!INDEX_NAME_RE.test(indexName)) return { error: 'ERR invalid index name' };
  let noContent = false;
  let offset = 0;
  let count = 10;
  let i = 2;
  while (i < args.length) {
    const tok = toStr(args[i]).toUpperCase();
    if (tok === 'NOCONTENT') {
      noContent = true;
      i += 1;
    } else if (tok === 'LIMIT') {
      if (i + 3 > args.length) return { error: 'ERR syntax error' };
      expectUtf8(args[i + 1]);
      expectUtf8(args[i + 2]);
      const o = parseInt(toStr(args[i + 1]), 10);
      const c = parseInt(toStr(args[i + 2]), 10);
      if (Number.isNaN(o) || Number.isNaN(c) || o < 0 || c < 0) return { error: 'ERR invalid limit' };
      offset = o;
      count = c;
      i += 3;
    } else {
      return { error: 'ERR syntax error' };
    }
  }
  return { indexName, query, noContent, offset, count };
}

/**
 * Parse FT.SUGADD args: IndexName Term Score [INCR] [PAYLOAD payload]
 * @param {Buffer[]} args
 * @returns {{ indexName: string, term: string, score: number, incr: boolean, payload?: string } | { error: string }}
 */
export function parseFtSugadd(args) {
  if (!args || args.length < 3) return { error: 'ERR syntax error' };
  expectUtf8(args[0]);
  expectUtf8(args[1]);
  expectUtf8(args[2]);
  const indexName = toStr(args[0]).trim();
  const term = toStr(args[1]);
  const scoreNum = parseFloat(toStr(args[2]));
  if (!INDEX_NAME_RE.test(indexName)) return { error: 'ERR invalid index name' };
  if (term.length < 1 || term.length > 256) return { error: 'ERR syntax error' };
  if (!Number.isFinite(scoreNum)) return { error: 'ERR invalid score' };
  let incr = false;
  let payload;
  let i = 3;
  while (i < args.length) {
    const tok = toStr(args[i]).toUpperCase();
    if (tok === 'INCR') {
      incr = true;
      i += 1;
    } else if (tok === 'PAYLOAD') {
      if (i + 1 >= args.length) return { error: 'ERR syntax error' };
      expectUtf8(args[i + 1]);
      payload = toStr(args[i + 1]);
      i += 2;
    } else {
      return { error: 'ERR syntax error' };
    }
  }
  return { indexName, term, score: scoreNum, incr, payload };
}

/**
 * Parse FT.SUGGET args: IndexName Prefix [MAX n] [WITHSCORES] [WITHPAYLOADS] [FUZZY]
 * @param {Buffer[]} args
 * @returns {{ indexName: string, prefix: string, max: number, withScores: boolean, withPayloads: boolean } | { error: string }}
 */
export function parseFtSugget(args) {
  if (!args || args.length < 2) return { error: 'ERR syntax error' };
  expectUtf8(args[0]);
  expectUtf8(args[1]);
  const indexName = toStr(args[0]).trim();
  const prefix = toStr(args[1]);
  if (!INDEX_NAME_RE.test(indexName)) return { error: 'ERR invalid index name' };
  let max = 5;
  let withScores = false;
  let withPayloads = false;
  let i = 2;
  while (i < args.length) {
    const tok = toStr(args[i]).toUpperCase();
    if (tok === 'FUZZY') return { error: 'ERR not supported yet' };
    if (tok === 'MAX') {
      if (i + 1 >= args.length) return { error: 'ERR syntax error' };
      expectUtf8(args[i + 1]);
      const n = parseInt(toStr(args[i + 1]), 10);
      if (Number.isNaN(n) || n < 0) return { error: 'ERR syntax error' };
      max = n;
      i += 2;
    } else if (tok === 'WITHSCORES') {
      withScores = true;
      i += 1;
    } else if (tok === 'WITHPAYLOADS') {
      withPayloads = true;
      i += 1;
    } else {
      return { error: 'ERR syntax error' };
    }
  }
  return { indexName, prefix, max, withScores, withPayloads };
}

/**
 * Parse FT.SUGDEL args: IndexName Term
 * @param {Buffer[]} args
 * @returns {{ indexName: string, term: string } | { error: string }}
 */
export function parseFtSugdel(args) {
  if (!args || args.length !== 2) return { error: 'ERR syntax error' };
  expectUtf8(args[0]);
  expectUtf8(args[1]);
  const indexName = toStr(args[0]).trim();
  const term = toStr(args[1]);
  if (!INDEX_NAME_RE.test(indexName)) return { error: 'ERR invalid index name' };
  return { indexName, term };
}
