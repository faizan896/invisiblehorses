import type Database from 'better-sqlite3';
import { fingerprint } from '../intent/fingerprint.js';
import { HistorySchema, historyTables } from '../workers/history.js';

/** Owner-only export. No keys enter the history payload; raw signed state remains private data. */
export function exportHistory(db: Database.Database, payerAddress: string, agentId: string) {
  const active = db.prepare("SELECT COUNT(*) n FROM payments WHERE funds_locked=1 OR status IN ('created','recipient_resolved','route_selected','funds_reserved','in_transit','settled','pending_approval','queued','preparing','submitted','uncertain')").get() as {n:number};
  if (active.n) throw new Error('Reconcile active payments before moving the signer');
  const known = new Set<string>(historyTables);
  const definitions = (db.prepare("SELECT type,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name").all() as {type:string;tbl_name:string;sql:string}[]).filter(r => known.has(r.tbl_name) && ['table','index','trigger'].includes(r.type));
  const tables = historyTables.filter(name => definitions.some(r => r.type==='table' && r.tbl_name===name)).map(name => {
    const columns = (db.pragma(`table_info(${name})`) as {name:string}[]).map(c => c.name);
    const rows = db.prepare(`SELECT ${columns.map(c => `"${c}"`).join(',')} FROM "${name}" ORDER BY rowid`).all() as Record<string,unknown>[];
    return {name,columns,rows:rows.map(row => columns.map(c => row[c]))};
  });
  const payload = {version:1,payer_address:payerAddress,agent_id:agentId,schema:definitions.map(r => r.sql),tables};
  return HistorySchema.parse({payload,sha256:fingerprint(payload)});
}
