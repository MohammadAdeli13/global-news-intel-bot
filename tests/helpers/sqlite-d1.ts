import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js";
import migration0001Sql from "../../migrations/0001_initial.sql?raw";
import migration0002Sql from "../../migrations/0002_add_images.sql?raw";

let sqlJsPromise: ReturnType<typeof initSqlJs> | null = null;

function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs();
  }
  return sqlJsPromise;
}

function normalizeParam(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  return String(value);
}

class SqlitePreparedStatement {
  private boundParams: SqlValue[] = [];

  constructor(
    private readonly sqlDb: SqlJsDatabase,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): SqlitePreparedStatement {
    const clone = new SqlitePreparedStatement(this.sqlDb, this.query);
    clone.boundParams = values.map(normalizeParam);
    return clone;
  }

  _executeSync<T = Record<string, unknown>>(): D1Result<T> {
    const stmt = this.sqlDb.prepare(this.query);
    try {
      if (this.boundParams.length > 0) {
        stmt.bind(this.boundParams);
      }
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      const trimmed = this.query.trimStart().toUpperCase();
      const isReadOnly =
        trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA");
      const changes = isReadOnly ? 0 : this.sqlDb.getRowsModified();
      return {
        results: rows,
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: rows.length,
          rows_written: changes,
          last_row_id: 0,
          changed_db: changes > 0,
          changes,
        },
      };
    } finally {
      stmt.free();
    }
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const res = this._executeSync<Record<string, unknown>>();
    const firstRow = res.results[0];
    if (!firstRow) return null;
    if (colName !== undefined) {
      return (firstRow[colName] as T) ?? null;
    }
    return firstRow as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this._executeSync<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this._executeSync<T>();
  }
}

export async function createTestD1(): Promise<{
  db: D1Database;
  close: () => void;
}> {
  const SQL = await getSqlJs();
  const sqlDb = new SQL.Database();
  sqlDb.run("PRAGMA foreign_keys = ON;");

  sqlDb.exec(migration0001Sql);
  sqlDb.exec(migration0002Sql);

  const d1Adapter = {
    prepare(query: string) {
      return new SqlitePreparedStatement(sqlDb, query);
    },
    async batch<T = unknown>(statements: SqlitePreparedStatement[]) {
      sqlDb.run("BEGIN IMMEDIATE");
      try {
        const results: D1Result<T>[] = [];
        for (const stmt of statements) {
          results.push(stmt._executeSync<T>());
        }
        sqlDb.run("COMMIT");
        return results;
      } catch (error) {
        sqlDb.run("ROLLBACK");
        throw error;
      }
    },
    async exec(query: string) {
      sqlDb.exec(query);
      return { count: 1, duration: 0 };
    },
  };

  return {
    db: d1Adapter as unknown as D1Database,
    close: () => sqlDb.close(),
  };
}