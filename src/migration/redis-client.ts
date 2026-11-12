/**
 * Minimal structural view of the `redis` v4 client used by the migration steps.
 * A client from `createClient()` satisfies it; tests can pass lightweight fakes.
 */

/**
 * SCAN reply: `redis` v4 returns the object form; the raw `[cursor, keys]` form is
 * accepted for clients that pass the RESP reply through unchanged.
 */
export type MigrationScanReply = { cursor: number; keys: string[] } | [cursor: string, keys: string[]];

export interface MigrationRedisClient {
  sendCommand(args: string[]): Promise<unknown>;
  dbSize(): Promise<number>;
  scan(cursor: number, options: { MATCH?: string; COUNT?: number }): Promise<MigrationScanReply>;
  type(key: string): Promise<string>;
  pTTL(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  hGetAll(key: string): Promise<Record<string, string>>;
  sMembers(key: string): Promise<string[]>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  zRangeWithScores(key: string, start: number, stop: number): Promise<Array<{ value: string; score: number }>>;
}
