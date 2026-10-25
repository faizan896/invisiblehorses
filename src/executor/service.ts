import { randomBytes, randomUUID } from 'node:crypto';
import { fingerprint } from '../intent/fingerprint.js';
import type { Hex } from 'viem';
import { Store, type PaymentRow } from '../audit/store.js';
import { PaymentIntentSchema, decimal, minor, type PaymentIntent } from '../intent/schema.js';
import { evaluate } from '../policy/engine.js';
import type { Policy } from '../policy/schema.js';
import { ApprovalTokens } from '../approval/tokens.js';
import type { Notifier, ApprovalNotification } from '../approval/notifier.js';
import type { TestnetExecutor } from '../rails/testnet.js';
import { AppError } from '../errors.js';

export class PaymentService {
  private ticking = false;
  constructor(
    readonly store: Store, private readonly policy: () => Policy,
    private readonly tokens: ApprovalTokens, private readonly notifier: Notifier,
    private readonly executor: TestnetExecutor, private readonly publicBaseUrl: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private now() { return this.clock().toISOString(); }
  async initialize() {
    await this.executor.assertTestnet();
    // A process died between claiming work and persisting a signed transaction.
    // Quarantine rather than assume a transfer did/didn't happen or allocate a new nonce.
    this.store.transaction(() => {
      const interrupted = this.store.db.prepare("SELECT * FROM payments WHERE status = 'preparing'").all() as PaymentRow[];
      for (const row of interrupted) this.store.transition(row.id, 'uncertain', 'execution_interrupted', 'system', { reason: 'Interrupted preparation; owner investigation required. No automatic replacement transaction.' }, this.now());
      this.store.expire(this.now());
    });
  }
  async request(input: unknown, authenticatedPayer: string) {
    const intent = PaymentIntentSchema.parse(input);
    if (intent.payer !== authenticatedPayer) throw new AppError(403, 'Payer does not match the authenticated agent');
    intent.amount = decimal(minor(intent.amount));
    const digest = fingerprint(intent);
    const result = this.store.transaction(() => {
      const now = this.now(); this.store.expire(now);
      const old = this.store.byKey(authenticatedPayer, intent.idempotency_key);
      if (old) {
        this.store.audit(old.id, 'request_retried', authenticatedPayer, { intent, conflicting_payload: old.fingerprint !== digest }, now);
        if (old.fingerprint !== digest) return { conflict: true as const, row: old, fresh: false };
        return { conflict: false as const, row: old, fresh: false };
      }
      const evaluation = evaluate(intent, this.policy(), this.store.history(now));
      const id = randomUUID();
      const row: PaymentRow = {
        id, payer: intent.payer, idempotency_key: intent.idempotency_key, fingerprint: digest,
        intent: JSON.stringify(intent), amount_minor: minor(intent.amount),
        status: evaluation.decision === 'deny' ? 'denied' : evaluation.decision === 'needs_approval' ? 'pending_approval' : 'queued',
        evaluation: JSON.stringify(evaluation), created_at: now, reserved_at: now, updated_at: now,
        transaction_hash: null, signed_transaction: null,
      };
      this.store.insert(row);
      this.store.audit(id, 'payment_requested', authenticatedPayer, { intent, ...evaluation }, now);
      if (row.status === 'pending_approval') this.store.db.prepare("INSERT INTO approvals(payment_id,nonce,expires_at,state) VALUES(?,?,?,'pending')").run(id, randomBytes(16).toString('hex'), new Date(Date.parse(now) + 15 * 60_000).toISOString());
      return { conflict: false as const, row, fresh: true };
    });
    if (result.conflict) throw new AppError(409, 'Idempotency key already belongs to a different intent');
    if (result.fresh && result.row.status === 'pending_approval') {
      try {
        await this.notifier.notify(this.notification(result.row));
        this.store.audit(result.row.id, 'notification_sent', 'system', { channel: 'ntfy' }, this.now());
      } catch {
        this.store.audit(result.row.id, 'notification_failed', 'system', { reason: 'Push delivery failed; owner can use /approvals' }, this.now());
      }
    }
    return this.view(this.store.get(result.row.id)!);
  }
  decide(token: string) {
    const now = this.now();
    const payload = this.tokens.verify(token, now);
    return this.store.transaction(() => {
      this.store.expire(now);
      const row = this.store.get(payload.payment_id);
      const approval = this.store.approval(payload.payment_id);
      if (!row || !approval || approval.nonce !== payload.nonce || approval.expires_at !== payload.expires_at) throw new AppError(403, 'Approval does not match the stored request');
      if (approval.state !== 'pending' || row.status !== 'pending_approval') throw new AppError(409, 'Approval has already been used or is no longer pending');
      const actor = 'owner:approval-token';
      this.store.db.prepare('UPDATE approvals SET state = ?, actor = ?, decided_at = ? WHERE payment_id = ?').run(payload.action === 'approve' ? 'approved' : 'rejected', actor, now, row.id);
      if (payload.action === 'reject') this.store.transition(row.id, 'rejected', 'payment_rejected', actor, { reason: 'Owner rejected payment' }, now);
      else {
        // Approval never overrides a hard gate, including a policy edited since the push.
        const evaluation = evaluate(JSON.parse(row.intent) as PaymentIntent, this.policy(), this.store.history(now, row.id));
        this.store.transition(row.id, evaluation.decision === 'deny' ? 'denied' : 'queued', 'payment_approved', actor, evaluation, now, evaluation);
        this.store.db.prepare('UPDATE payments SET reserved_at = ? WHERE id = ?').run(now, row.id);
      }
      return this.view(this.store.get(row.id)!);
    });
  }
  pending() {
    this.store.transaction(() => this.store.expire(this.now()));
    const rows = this.store.db.prepare("SELECT * FROM payments WHERE status = 'pending_approval' ORDER BY created_at").all() as PaymentRow[];
    return rows.map((row) => ({ payment: this.view(row), notification: this.notification(row) }));
  }
  private notification(row: PaymentRow): ApprovalNotification {
    const approval = this.store.approval(row.id)!;
    const url = (action: 'approve' | 'reject') => {
      const u = new URL('/approval-actions', this.publicBaseUrl);
      u.searchParams.set('token', this.tokens.sign({ v: 1, payment_id: row.id, action, nonce: approval.nonce, expires_at: approval.expires_at }));
      return u.toString();
    };
    return { paymentId: row.id, intent: JSON.parse(row.intent) as PaymentIntent, approveUrl: url('approve'), rejectUrl: url('reject'), expiresAt: approval.expires_at };
  }
  view(row: PaymentRow) {
    const approval = this.store.approval(row.id);
    const intent = JSON.parse(row.intent) as PaymentIntent;
    return {
      id: row.id, intent: JSON.parse(row.intent) as PaymentIntent, status: row.status,
      evaluation: JSON.parse(row.evaluation) as { decision: string; reasons: string[] },
      transaction_hash: row.transaction_hash, created_at: row.created_at, updated_at: row.updated_at,
      approval: approval ? { state: approval.state, expires_at: approval.expires_at, approved_by: approval.actor } : null,
      summary: { payer: row.payer, recipient: intent.recipient.name, amount: intent.amount, currency: 'USD', source_cost_usd: intent.amount, purpose: intent.purpose },
      network: 'Base Sepolia TEST ONLY',
    };
  }
  get(id: string, payer?: string) {
    const row = this.store.get(id);
    if (!row || (payer && row.payer !== payer)) throw new AppError(404, 'Payment not found');
    return this.view(row);
  }
  list(payer?: string, limit = 100) { return this.store.list(payer, limit).map((row) => this.view(row)); }
  limits() {
    return this.store.transaction(() => {
      this.store.expire(this.now());
      const policy = this.policy(); const history = this.store.history(this.now());
      return { ...policy, spent_or_reserved_today: history.spent_today, remaining_today: decimal(Math.max(0, minor(policy.max_per_day) - minor(history.spent_today))), day_boundary: 'UTC', network: 'Base Sepolia TEST ONLY' };
    });
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.store.transaction(() => this.store.expire(this.now()));
      // Persisted bytes can be rebroadcast after a timeout/restart: the hash stays identical.
      const submitted = this.store.db.prepare("SELECT * FROM payments WHERE status = 'submitted' ORDER BY rowid LIMIT 1").get() as PaymentRow | undefined;
      if (submitted) { await this.reconcile(submitted); return; }
      const row = this.store.transaction(() => {
        if (this.store.db.prepare("SELECT id FROM payments WHERE status IN ('preparing','uncertain') LIMIT 1").get()) return;
        const next = this.store.db.prepare("SELECT * FROM payments WHERE status = 'queued' ORDER BY rowid LIMIT 1").get() as PaymentRow | undefined;
        if (!next) return;
        const now = this.now();
        const evaluation = evaluate(JSON.parse(next.intent) as PaymentIntent, this.policy(), this.store.history(now, next.id));
        const approved = this.store.approval(next.id)?.state === 'approved';
        if (evaluation.decision === 'deny' || (evaluation.decision === 'needs_approval' && !approved)) {
          this.store.transition(next.id, 'denied', 'execution_policy_denied', 'system', evaluation, now, evaluation);
          return;
        }
        this.store.transition(next.id, 'preparing', 'execution_claimed', 'system', evaluation, now);
        this.store.db.prepare('UPDATE payments SET reserved_at = ? WHERE id = ?').run(now, next.id);
        return next;
      });
      if (!row) return;
      let signed;
      try {
        await this.executor.assertTestnet();
        signed = await this.executor.prepare(JSON.parse(row.intent) as PaymentIntent);
      } catch {
        this.store.transaction(() => this.store.transition(row.id, 'failed', 'preparation_failed', 'system', { reason: 'Testnet transaction preparation failed before broadcast; check test funds, gas and RPC' }, this.now()));
        return;
      }
      const persisted = this.store.transaction(() => {
        if (this.store.get(row.id)?.status !== 'preparing') throw new AppError(409, 'Execution claim lost; signed transaction will not be broadcast');
        // Preparation may span a UTC rollover or an owner policy edit. Recheck before money leaves.
        const now = this.now();
        const evaluation = evaluate(JSON.parse(row.intent) as PaymentIntent, this.policy(), this.store.history(now, row.id));
        if (evaluation.decision === 'deny' || (evaluation.decision === 'needs_approval' && this.store.approval(row.id)?.state !== 'approved')) {
          this.store.transition(row.id, 'denied', 'execution_policy_denied', 'system', evaluation, now, evaluation);
          return false;
        }
        this.store.db.prepare("UPDATE payments SET signed_transaction = ?, transaction_hash = ?, status = 'submitted', updated_at = ? WHERE id = ?").run(signed.raw, signed.hash, this.now(), row.id);
        this.store.db.prepare('UPDATE payments SET reserved_at = ? WHERE id = ?').run(now, row.id);
        this.store.audit(row.id, 'transaction_persisted', 'system', { transaction_hash: signed.hash }, this.now());
        return true;
      });
      if (persisted) await this.reconcile(this.store.get(row.id)!);
    } finally { this.ticking = false; }
  }
  private async reconcile(row: PaymentRow) {
    try {
      await this.executor.assertTestnet();
      const hash = row.transaction_hash as Hex;
      const state = await this.executor.receipt(hash);
      if (state === 'pending') {
        const returnedHash = await this.executor.broadcast(row.signed_transaction as Hex);
        if (returnedHash.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC returned an unexpected transaction hash');
        return;
      }
      this.store.transaction(() => {
        if (this.store.get(row.id)?.status !== 'submitted') return;
        this.store.transition(row.id, state === 'success' ? 'completed' : 'failed', state === 'success' ? 'payment_completed' : 'transaction_reverted', 'system', { transaction_hash: hash, testnet: true }, this.now());
      });
    } catch {
      // An ambiguous submission is never converted to "failed" and paid again.
      // Keep its reservation and reconcile the SAME hash/bytes on the next tick.
      this.store.audit(row.id, 'reconciliation_pending', 'system', { reason: 'RPC result unavailable; no replacement transfer will be created', transaction_hash: row.transaction_hash }, this.now());
    }
  }
}
