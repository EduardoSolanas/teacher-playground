import type { RoomDatabase, RoomStatement } from './db';

/**
 * Adapter for Cloudflare Durable Object SQLite storage.
 * Implements the RoomDatabase interface over ctx.storage.sql.
 */
export class DODatabase implements RoomDatabase {
  constructor(
    private sql: SqlStorage,
    private storage: DurableObjectStorage,
  ) {}

  prepare(sqlQuery: string): RoomStatement {
    return new DOStatement(this.sql, sqlQuery);
  }

  exec(sql: string): void {
    this.sql.exec(sql);
  }

  transaction<T>(fn: () => T): () => T {
    return () => this.storage.transactionSync(fn);
  }
}

class DOStatement implements RoomStatement {
  constructor(
    private sql: SqlStorage,
    private sqlQuery: string,
  ) {}

  get(...params: unknown[]): unknown {
    const rows = this.sql.exec(this.sqlQuery, ...params).toArray();
    return rows.length === 0 ? undefined : rows[0];
  }

  all(...params: unknown[]): unknown[] {
    return this.sql.exec(this.sqlQuery, ...params).toArray();
  }

  // `changes` must match better-sqlite3: the rows actually modified by the
  // statement. Cursor.rowsWritten is an I/O metric that also counts index
  // writes, so it is not interchangeable here — access.ts derives
  // authorization booleans from this value.
  run(...params: unknown[]): { changes: number } {
    this.sql.exec(this.sqlQuery, ...params);
    const row = this.sql.exec('SELECT changes() AS c').one() as { c: number };
    return { changes: Number(row.c) };
  }
}
