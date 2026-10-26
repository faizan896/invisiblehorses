import { z } from 'zod';
import { fingerprint } from '../intent/fingerprint.js';
import { AddressSchema, IdSchema } from '../intent/schema.js';
import type { SqlDatabase } from '../audit/store-core.js';

export const historyTables = ['payments','approvals','audit','route_plans','payment_contexts','test_rail_accounts','test_rail_holds','rail_operations','test_rail_journal','resource_requests'] as const;
const Scalar = z.union([z.string(), z.number().finite(), z.null()]);
const Table = z.strictObject({ name: z.enum(historyTables), columns: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)).min(1), rows: z.array(z.array(Scalar)) });
export const HistorySchema = z.strictObject({
  payload: z.strictObject({ version: z.literal(1), payer_address: AddressSchema, agent_id: IdSchema, schema: z.array(z.string().max(20000)), tables: z.array(Table).min(3) }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export function importHistory(db: SqlDatabase, input: unknown, payerAddress: string, agentId: string) {
  const { payload, sha256 } = HistorySchema.parse(input);
  if (fingerprint(payload) !== sha256) throw new Error('History checksum mismatch');
  if (payload.payer_address.toLowerCase() !== payerAddress.toLowerCase() || payload.agent_id !== agentId) throw new Error('History belongs to a different wallet or payer');
  if (new Set(payload.tables.map(t => t.name)).size !== payload.tables.length) throw new Error('Duplicate history tables');
  for (const name of ['payments','approvals','audit']) if (!payload.tables.some(t => t.name === name)) throw new Error('Required history table missing');
  for (const sql of payload.schema) if (!/^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX|TRIGGER)\s/i.test(sql)) throw new Error('Unexpected history schema statement');
  db.transaction(() => {
    const imported = db.prepare("SELECT value FROM railgate_hosted_meta WHERE key = 'history_hash'").get();
    if (imported) throw new Error('History has already been imported; refusing to replace payment state');
    for (const table of ['payments','audit']) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (exists && (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n) throw new Error('Payment state already exists; refusing import');
    }
    for (const sql of payload.schema) db.exec(sql.replace(/^(CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX|TRIGGER))\s+(?!IF NOT EXISTS)/i, '$1 IF NOT EXISTS '));
    for (const table of payload.tables) {
      const statement = db.prepare(`INSERT INTO "${table.name}" (${table.columns.map(c => `"${c}"`).join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`);
      for (const row of table.rows) { if (row.length !== table.columns.length) throw new Error('History row width mismatch'); statement.run(...row); }
    }
    db.prepare("INSERT INTO railgate_hosted_meta(key,value) VALUES('history_hash',?)").run(sha256);
    db.prepare("INSERT INTO railgate_hosted_meta(key,value) VALUES('active','0')").run();
  }).immediate();
  return { sha256, payments: payload.tables.find(t => t.name === 'payments')!.rows.length };
}
