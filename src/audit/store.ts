import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decimal, type PaymentIntent } from '../intent/schema.js';
import type { Evaluation } from '../policy/engine.js';

export type PaymentStatus = 'created' | 'recipient_resolved' | 'route_selected' | 'funds_reserved' | 'in_transit' | 'settled' | 'returned' | 'pending_approval' | 'queued' | 'preparing' | 'submitted' | 'completed' | 'denied' | 'rejected' | 'expired' | 'failed' | 'uncertain';
export type PaymentRow = {
  id: string; payer: string; idempotency_key: string; fingerprint: string; intent: string;
  amount_minor: number; status: PaymentStatus; evaluation: string;
  created_at: string; reserved_at: string; updated_at: string;
  transaction_hash: string | null; signed_transaction: string | null;
  funds_locked?: number; spent_minor?: number;
};
export type ApprovalRow = { payment_id: string; nonce: string; expires_at: string; state: 'pending' | 'approved' | 'rejected' | 'expired'; actor: string | null; decided_at: string | null };
export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, payer TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, intent TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        status TEXT NOT NULL, evaluation TEXT NOT NULL,
        created_at TEXT NOT NULL, reserved_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        transaction_hash TEXT, signed_transaction TEXT,
        UNIQUE(payer, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        payment_id TEXT PRIMARY KEY REFERENCES payments(id), nonce TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL, state TEXT NOT NULL, actor TEXT, decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id TEXT REFERENCES payments(id),
        event TEXT NOT NULL, actor TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
      CREATE INDEX IF NOT EXISTS payments_reservations ON payments(status, reserved_at);
    `);
    this.db.transaction(() => {
      const columns = this.db.pragma('table_info(payments)') as { name: string }[];
      for (const name of ['funds_locked', 'spent_minor']) {
        if (!columns.some((c) => c.name === name)) this.db.exec(`ALTER TABLE payments ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
      }
    }).immediate();
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  get(id: string) { return this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as PaymentRow | undefined; }
  byKey(payer: string, key: string) { return this.db.prepare('SELECT * FROM payments WHERE payer = ? AND idempotency_key = ?').get(payer, key) as PaymentRow | undefined; }
  approval(id: string) { return this.db.prepare('SELECT * FROM approvals WHERE payment_id = ?').get(id) as ApprovalRow | undefined; }
  insert(row: PaymentRow) { this.db.prepare(`INSERT INTO payments(id,payer,idempotency_key,fingerprint,intent,amount_minor,status,evaluation,created_at,reserved_at,updated_at,transaction_hash,signed_transaction) VALUES (@id,@payer,@idempotency_key,@fingerprint,@intent,@amount_minor,@status,@evaluation,@created_at,@reserved_at,@updated_at,@transaction_hash,@signed_transaction)`).run(row); }
  audit(paymentId: string | null, event: string, actor: string, details: unknown, now: string) {
    this.db.prepare('INSERT INTO audit(payment_id,event,actor,details,created_at) VALUES(?,?,?,?,?)').run(paymentId, event, actor, JSON.stringify(details), now);
  }
  history(now: string, exclude = '') {
    const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
    const total = this.db.prepare(`SELECT COALESCE(SUM(CASE
      WHEN status = 'completed' THEN amount_minor
      WHEN funds_locked = 1 OR status IN ('pending_approval','queued','preparing','submitted','uncertain') THEN amount_minor
      WHEN status IN ('failed','returned') THEN spent_minor ELSE 0 END),0) AS total FROM payments
      WHERE id != ? AND reserved_at >= ? AND reserved_at < ?
      `).get(exclude, start.toISOString(), end.toISOString()) as { total: number };
    const paid = this.db.prepare("SELECT intent FROM payments WHERE status = 'completed'").all() as { intent: string }[];
    return { now, spent_today: decimal(total.total), paid_merchants: paid.map((p) => {
      const i = JSON.parse(p.intent) as PaymentIntent;
      return `${i.recipient.id}:${i.recipient.address.toLowerCase()}`;
    }) };
  }
  transition(id: string, status: PaymentStatus, event: string, actor: string, details: unknown, now: string, evaluation?: Evaluation) {
    this.db.prepare('UPDATE payments SET status = ?, updated_at = ?, evaluation = COALESCE(?,evaluation) WHERE id = ?').run(status, now, evaluation ? JSON.stringify(evaluation) : null, id);
    this.audit(id, event, actor, details, now);
  }
  expire(now: string) {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE state = 'pending' AND expires_at <= ?").all(now) as ApprovalRow[];
    for (const row of rows) {
      this.db.prepare("UPDATE approvals SET state = 'expired', decided_at = ? WHERE payment_id = ?").run(now, row.payment_id);
      this.db.prepare('UPDATE payments SET funds_locked = 0 WHERE id = ?').run(row.payment_id);
      this.transition(row.payment_id, 'expired', 'approval_expired', 'system', { reason: 'Approval window expired after 15 minutes' }, now);
    }
  }
  list(payer?: string, limit = 100) {
    return (payer ? this.db.prepare('SELECT * FROM payments WHERE payer = ? ORDER BY rowid DESC LIMIT ?').all(payer, limit) : this.db.prepare('SELECT * FROM payments ORDER BY rowid DESC LIMIT ?').all(limit)) as PaymentRow[];
  }
  events(limit = 200) { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit); }
  close() { this.db.close(); }
}
