export interface RoomStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
}

export interface RoomDatabase {
  prepare(sql: string): RoomStatement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
}
