import type { SqlDatabase, SqlStatement } from '../audit/store-core.js';

type Value = string | number | ArrayBuffer | null;
export interface SqlCursor { toArray(): Record<string, unknown>[] }
export interface DurableStorage {
  sql: { exec(query: string, ...bindings: Value[]): SqlCursor };
  transactionSync<T>(callback: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  sync(): Promise<void>;
}

function bindings(query: string, parameters: unknown[]) {
  if (parameters.length === 1 && parameters[0] && typeof parameters[0] === 'object' && !ArrayBuffer.isView(parameters[0]) && !(parameters[0] instanceof ArrayBuffer)) {
    const named = parameters[0] as Record<string, unknown>, values: unknown[] = [];
    // Core queries use @name only for the fixed INSERT template, never for user SQL.
    query = query.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key: string) => { if (!(key in named)) throw new Error('Missing SQL binding'); values.push(named[key]); return '?'; });
    parameters = values;
  }
  const values = parameters.map((v): Value => {
    if (v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || v instanceof ArrayBuffer) return v;
    throw new Error('Unsupported SQLite binding');
  });
  return { query, values };
}

/** Real SQLite on one Durable Object; transactionSync supplies the single-writer transaction. */
export class DurableSqlite implements SqlDatabase {
  constructor(readonly storage: DurableStorage) {}
  exec(sql: string) { return this.storage.sql.exec(sql).toArray(); }
  prepare(sql: string): SqlStatement {
    const execute = (parameters: unknown[]) => { const p = bindings(sql, parameters); return this.storage.sql.exec(p.query, ...p.values).toArray(); };
    return {
      all: (...p) => execute(p), get: (...p) => execute(p)[0],
      run: (...p) => { execute(p); const row = this.storage.sql.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').toArray()[0]!; return { changes: Number(row.changes), lastInsertRowid: Number(row.lastInsertRowid) }; },
    };
  }
  pragma(sql: string, options?: { simple?: boolean }) {
    // These connection-level settings are controlled by Cloudflare, not by a filesystem driver.
    if (/^(journal_mode|busy_timeout)\s*=/i.test(sql)) return [];
    const rows = this.storage.sql.exec('PRAGMA ' + sql).toArray();
    return options?.simple ? Object.values(rows[0] ?? {})[0] : rows;
  }
  transaction<T>(fn: () => T) {
    const run = () => this.storage.transactionSync(() => {
      const result = fn();
      if (result && typeof result === 'object' && 'then' in result) throw new Error('SQLite transactions must be synchronous');
      return result;
    });
    return Object.assign(run, { immediate: run });
  }
  close() { /* Cloudflare owns the durable connection lifecycle. */ }
}
