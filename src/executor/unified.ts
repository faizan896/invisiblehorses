import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, type PaymentRow, type PaymentStatus } from '../audit/store.js';
import { ApprovalTokens } from '../approval/tokens.js';
import type { ApprovalNotification, Notifier } from '../approval/notifier.js';
import { Counterparties, CounterpartySchema } from '../counterparty/profiles.js';
import { AppError } from '../errors.js';
import { fingerprint } from '../intent/fingerprint.js';
import { PaymentIntentSchema, decimal, minor } from '../intent/schema.js';
import { PaymentIntentV2Schema, type RoutingIntent } from '../intent/routing.js';
import type { Policy } from '../policy/schema.js';
import { RouteQuoteSchema, RailIdSchema, type QuoteContext, type RailExecution, type RouteQuote } from '../rails/adapter.js';
import { planRoutes, policyIntent } from '../router/engine.js';
import { RoutingService } from '../router/service.js';
import { bankWindow } from '../rails/calendar.js';
import { PaymentService } from './service.js';
import { RailRuntime } from './rail-runtime.js';
import { assertTransition, RouteFailure, safeFallback, WalletBusy } from './state.js';

export const RequestSchema = z.union([PaymentIntentV2Schema, PaymentIntentSchema]);
const Context = z.object({
  original: RequestSchema, intent: PaymentIntentV2Schema, recipient: CounterpartySchema.nullable(),
  quote: RouteQuoteSchema.nullable(), operation: z.string().nullable(), attempt: z.number().int(),
  approved: z.number().int().nullable(), failedRails: z.array(RailIdSchema), explanation: z.string(), returning: z.boolean(),
});
type Context = z.infer<typeof Context>;
const noOutflow: RailExecution = { id: 'unsubmitted', status: 'failed', irreversible: false, recipient_usable: false, funds_may_have_left: false, fx_exposure: false, charged_fee_usd: '0.00' };

/** All NEW requests use the same gated lifecycle. M1 rows retain their exact fingerprints and hashes. */
export class UnifiedPaymentService {
  private ticking = false;
  constructor(readonly store: Store, private readonly legacy: PaymentService, private readonly profiles: Counterparties, private readonly routing: RoutingService, private readonly runtime: RailRuntime, private readonly policy: () => Policy, private readonly tokens: ApprovalTokens, private readonly notifier: Notifier, private readonly origin: string, private readonly clock: () => Date = () => new Date()) {
    store.db.exec('CREATE TABLE IF NOT EXISTS payment_contexts(payment_id TEXT PRIMARY KEY REFERENCES payments(id), context TEXT NOT NULL)');
    runtime.authorize = (id, c, q) => {
      const data = this.context(id);
      if (!data || !data.quote || fingerprint(data.quote) !== fingerprint(q) || fingerprint(data.intent) !== fingerprint(c.intent)) throw new Error('Execution does not match persisted authorization');
      const gate = this.gate(id, data, q);
      if (!gate.selected || (gate.decision === 'needs_approval' && data.approved === null) || (data.approved !== null && minor(q.total_all_in_cost.amount) > data.approved)) throw new Error('Current authorization does not permit execution');
      this.store.db.prepare('UPDATE payments SET reserved_at = ? WHERE id = ?').run(this.now(), id);
    };
  }
  private now() { return this.clock().toISOString(); }
  private context(id: string) {
    const row = this.store.db.prepare('SELECT context FROM payment_contexts WHERE payment_id = ?').get(id) as { context: string } | undefined;
    return row ? Context.parse(JSON.parse(row.context)) : null;
  }
  private save(id: string, data: Context) { this.store.db.prepare('UPDATE payment_contexts SET context = ? WHERE payment_id = ?').run(JSON.stringify(Context.parse(data)), id); }
  private move(id: string, status: PaymentStatus, details: unknown = {}) {
    const row = this.store.get(id)!;
    if (row.status === status) return;
    assertTransition(row.status, status);
    this.store.transition(id, status, `payment_${status}`, 'system', details, this.now());
    if (status === 'failed') {
      const d = details as { reason?: string; reasons?: string[] };
      this.store.db.prepare('UPDATE payments SET evaluation = ? WHERE id = ?').run(JSON.stringify({ decision: 'deny', reasons: d.reasons ?? [d.reason ?? 'Payment failed; owner investigation required'] }), id);
    }
  }
  private unlock(id: string) { this.runtime.release(id); this.store.db.prepare('UPDATE payments SET funds_locked = 0 WHERE id = ?').run(id); }
  private expire() {
    this.store.expire(this.now());
    this.store.db.prepare("UPDATE test_rail_holds SET state = 'released' WHERE state = 'active' AND payment_id IN (SELECT id FROM payments WHERE status IN ('expired','rejected','denied'))").run();
  }
  async initialize() { await this.legacy.initialize(); await this.runtime.initialize(); this.store.transaction(() => this.expire()); }
  async request(input: unknown, payer: string) {
    const original = RequestSchema.parse(input); original.amount = decimal(minor(original.amount));
    if (original.payer !== payer) throw new AppError(403, 'Payer does not match the authenticated agent');
    const digest = fingerprint(original);
    const id = this.store.transaction(() => {
      const previous = this.store.byKey(payer, original.idempotency_key);
      if (previous) {
        this.store.audit(previous.id, 'request_retried', payer, { conflicting_payload: previous.fingerprint !== digest }, this.now());
        if (previous.fingerprint !== digest) throw new AppError(409, 'Idempotency key already belongs to a different intent');
        return previous.id;
      }
      let intent: RoutingIntent;
      if (typeof original.recipient === 'string') intent = PaymentIntentV2Schema.parse(original);
      else {
        const recipient = this.profiles.get(original.recipient.id);
        if (recipient.stablecoin_wallets[0]?.address.toLowerCase() !== original.recipient.address.toLowerCase()) throw new AppError(403, 'Legacy destination must match the owner counterparty catalog');
        intent = PaymentIntentV2Schema.parse({ ...original, recipient: recipient.id, destination_currency: 'USD', deadline: new Date(this.clock().getTime() + 86400000).toISOString(), max_fee: '2.00', reversibility_requirement: 'none', recipient_preferences: { delivery: 'wallet' } });
      }
      const id = randomUUID(), now = this.now();
      const placeholder = { idempotency_key: intent.idempotency_key, payer, amount: intent.amount, recipient: { id: intent.recipient, name: intent.recipient, address: '0x0000000000000000000000000000000000000000' }, purpose: intent.purpose };
      this.store.insert({ id, payer, idempotency_key: intent.idempotency_key, fingerprint: digest, intent: JSON.stringify(placeholder), amount_minor: minor(intent.amount), status: 'created', evaluation: JSON.stringify({ decision: 'allow', reasons: ['Awaiting recipient resolution and deterministic route gates'] }), created_at: now, reserved_at: now, updated_at: now, transaction_hash: null, signed_transaction: null });
      const data: Context = { original, intent, recipient: null, quote: null, operation: null, attempt: 0, approved: null, failedRails: [], explanation: 'Awaiting route selection', returning: false };
      this.store.db.prepare('INSERT INTO payment_contexts VALUES(?,?)').run(id, JSON.stringify(data));
      this.store.audit(id, 'payment_requested', payer, { intent: original }, now);
      return id;
    });
    return this.get(id, payer);
  }
  private gate(id: string, data: Context, quote: RouteQuote) {
    const payer = this.profiles.get(data.intent.payer), recipient = this.profiles.get(data.intent.recipient);
    if (!data.recipient || fingerprint(data.recipient) !== fingerprint(recipient)) return { decision: 'deny' as const, selected: null, reasons: ['Owner recipient profile changed; submit a new intent for review'], explanation: 'Recipient changed', alternatives: [] };
    const currentQuote = structuredClone(quote);
    if (['ach-mock','wise-quote'].includes(quote.rail)) currentQuote.constraints.accepting_now = bankWindow(this.now()).accepting_now;
    return planRoutes({ intent: data.intent, payer, recipient, policy: this.policy(), history: this.store.history(this.now(), id), quotes: [currentQuote], unavailable: [] });
  }
  private deny(id: string, reasons: string[]) {
    this.unlock(id); this.move(id, 'denied', { reasons });
    this.store.db.prepare('UPDATE payments SET evaluation = ? WHERE id = ?').run(JSON.stringify({ decision: 'deny', reasons }), id);
  }
  private async choose(id: string, data: Context) {
    const plan = await this.routing.plan(data.intent, data.intent.payer, { excludePayment: id, failedRails: data.failedRails });
    this.store.transaction(() => {
      const row = this.store.get(id)!;
      if (!['recipient_resolved','route_selected'].includes(row.status)) return;
      const q = plan.selected;
      if (!q) { this.deny(id, [plan.explanation]); return; }
      const safe = safeFallback(data.intent, q, noOutflow, data.approved);
      if (!safe.safe) { this.unlock(id); this.move(id, 'failed', { reasons: safe.reasons }); return; }
      const current = this.profiles.get(data.intent.recipient);
      if (data.recipient && fingerprint(data.recipient) !== fingerprint(current)) { this.deny(id, ['Owner recipient profile changed']); return; }
      data.recipient = current; data.quote = q; data.operation = null; data.explanation = plan.explanation;
      this.save(id, data);
      this.store.db.prepare('UPDATE payments SET intent = ?,amount_minor = ?,evaluation = ? WHERE id = ?').run(JSON.stringify(policyIntent(data.intent, current, q)), minor(q.total_all_in_cost.amount), JSON.stringify({ decision: plan.decision, reasons: plan.reasons }), id);
      this.move(id, 'route_selected', { route_plan_id: plan.id, explanation: plan.explanation, alternatives: plan.alternatives });
    });
  }
  private notification(row: PaymentRow): ApprovalNotification {
    const approval = this.store.approval(row.id)!;
    const link = (action: 'approve' | 'reject') => { const url = new URL('/approval-actions', this.origin); url.searchParams.set('token', this.tokens.sign({ v: 1, payment_id: row.id, nonce: approval.nonce, expires_at: approval.expires_at, action })); return url.toString(); };
    return { paymentId: row.id, intent: PaymentIntentSchema.parse(JSON.parse(row.intent)), expiresAt: approval.expires_at, approveUrl: link('approve'), rejectUrl: link('reject') };
  }
  decide(token: string) {
    const payload = this.tokens.verify(token, this.now());
    if (!this.context(payload.payment_id)) return this.legacy.decide(token);
    return this.store.transaction(() => {
      this.expire();
      const row = this.store.get(payload.payment_id)!, approval = this.store.approval(row.id), data = this.context(row.id)!;
      if (!approval || approval.nonce !== payload.nonce || approval.expires_at !== payload.expires_at) throw new AppError(403, 'Approval does not match stored request');
      if (approval.state !== 'pending' || row.status !== 'pending_approval') throw new AppError(409, 'Approval already used or no longer pending');
      this.store.db.prepare('UPDATE approvals SET state = ?,actor = ?,decided_at = ? WHERE payment_id = ?').run(payload.action === 'approve' ? 'approved' : 'rejected', 'owner:approval-token', this.now(), row.id);
      if (payload.action === 'reject') { this.unlock(row.id); this.move(row.id, 'rejected', { actor: 'owner:approval-token' }); }
      else { data.approved = row.amount_minor; this.save(row.id, data); this.move(row.id, 'funds_reserved', { actor: 'owner:approval-token', approved_source_usd: decimal(row.amount_minor) }); }
      return this.get(row.id);
    });
  }
  pending() {
    this.store.transaction(() => this.expire());
    return (this.store.db.prepare("SELECT * FROM payments WHERE status = 'pending_approval' ORDER BY created_at").all() as PaymentRow[]).map((r) => ({ payment: this.view(r), notification: this.context(r.id) ? this.notification(r) : this.legacy.pending().find((p) => p.payment.id === r.id)!.notification }));
  }
  view(row: PaymentRow) {
    const base = this.legacy.view(row), data = this.context(row.id);
    if (!data) return { ...base, status: ({ queued: 'funds_reserved', preparing: 'in_transit', submitted: 'in_transit', uncertain: 'failed' } as Partial<Record<PaymentStatus, PaymentStatus>>)[row.status] ?? row.status };
    return { ...base, intent: data.original, status: row.status, summary: { payer: row.payer, recipient: data.recipient?.name ?? data.intent.recipient, amount: data.intent.amount, currency: data.intent.destination_currency, source_cost_usd: data.quote?.total_all_in_cost.amount ?? null, purpose: data.intent.purpose }, explanation: data.explanation, test_money_only: true };
  }
  get(id: string, payer?: string) { const row = this.store.get(id); if (!row || (payer && row.payer !== payer)) throw new AppError(404, 'Payment not found'); return this.view(row); }
  list(payer?: string, limit = 100) { return this.store.list(payer, limit).map((r) => this.view(r)); }
  limits() { this.store.transaction(() => this.expire()); return this.legacy.limits(); }
  async reverse(id: string) {
    const row = this.store.get(z.uuid().parse(id)), data = this.context(id);
    if (row?.status === 'returned') return this.get(id);
    if (!row || !data?.operation || !data.quote || !['completed','settled','failed'].includes(row.status)) throw new AppError(409, 'This payment has no returnable operation');
    const outcome = await this.runtime.reverse(data.quote.rail, data.operation);
    data.returning = true; this.save(id, data);
    if (row.status === 'completed' && outcome.status !== 'returned') this.store.transaction(() => { this.store.db.prepare('UPDATE payments SET funds_locked = 1 WHERE id = ?').run(id); this.move(id, 'settled', { reason: 'Return requested; awaiting confirmed source credit' }); });
    this.apply(id, data, outcome);
    return this.get(id);
  }
  private apply(id: string, data: Context, out: RailExecution) {
    this.store.transaction(() => {
      data.operation = out.id; this.save(id, data);
      const row = this.store.get(id)!;
      if (out.transaction_hash) this.store.db.prepare('UPDATE payments SET transaction_hash = ? WHERE id = ?').run(out.transaction_hash, id);
      if (out.status === 'returned') { this.unlock(id); this.store.db.prepare('UPDATE payments SET spent_minor = ? WHERE id = ?').run(minor(out.charged_fee_usd ?? '0'), id); this.move(id, 'returned', { refunded_usd: out.refunded_usd, retained_fee_usd: out.charged_fee_usd }); }
      else if (out.status === 'settled' && !data.returning) {
        if (row.status === 'in_transit' || row.status === 'failed') this.move(id, 'settled', { recipient_usable: out.recipient_usable });
        else if (row.status === 'settled' && out.recipient_usable) { this.unlock(id); this.move(id, 'completed', { recipient_usable: true }); }
      }
      else if (out.status === 'failed') {
        if (out.funds_may_have_left === false && out.fx_exposure === false) { this.unlock(id); this.store.db.prepare('UPDATE payments SET spent_minor = ? WHERE id = ?').run(minor(out.charged_fee_usd ?? '0'), id); }
        if (!['failed','completed'].includes(row.status)) this.move(id, 'failed', { reason: out.reason ?? 'Route failed; outcome requires investigation', no_fallback: true });
        if (row.status !== 'failed') this.store.audit(id, 'route_failed', 'system', { reason: out.reason, funds_may_have_left: out.funds_may_have_left, fx_exposure: out.fx_exposure }, this.now());
      }
    });
  }
  async tick() {
    if (this.ticking) return; this.ticking = true;
    try {
      await this.legacy.tick(); this.store.transaction(() => this.expire());
      const rows = this.store.db.prepare("SELECT p.* FROM payments p JOIN payment_contexts c ON c.payment_id = p.id WHERE p.status IN ('created','recipient_resolved','route_selected','funds_reserved','in_transit','settled','failed','completed') ORDER BY p.rowid").all() as PaymentRow[];
      for (const row of rows) {
        const data = this.context(row.id)!;
        if (row.status === 'completed' && !data.returning) continue;
        if (row.status === 'failed' && !row.funds_locked && !data.returning) continue;
        try { await this.step(row, data); }
        catch (error) {
          if (error instanceof WalletBusy) continue;
          this.store.transaction(() => {
            const current = this.store.get(row.id)!;
            if (['created','recipient_resolved','route_selected','funds_reserved'].includes(current.status)) { this.unlock(row.id); this.move(row.id, 'failed', { reason: 'Cannot resolve or authorize payment; no funds submitted' }); }
            else if (current.status === 'in_transit' || (current.status === 'settled' && data.returning)) this.move(row.id, 'failed', { reason: 'Execution or return outcome unavailable; original funds remain accounted for and no fallback is attempted' });
            this.store.audit(row.id, 'worker_error', 'system', { reason: 'Operation unavailable; original operation retained for reconciliation' }, this.now());
          });
        }
      }
    } finally { this.ticking = false; }
  }
  private async step(row: PaymentRow, data: Context) {
    const id = row.id;
    if (row.status === 'created') { data.recipient = this.profiles.get(data.intent.recipient); this.store.transaction(() => { this.save(id, data); this.move(id, 'recipient_resolved'); }); return; }
    if (row.status === 'recipient_resolved' || (row.status === 'route_selected' && (!data.quote || Date.parse(data.quote.expires_at) <= Date.parse(this.now())))) { await this.choose(id, data); return; }
    const q = data.quote!;
    const c: QuoteContext = { intent: data.intent, payer: this.profiles.get(data.intent.payer), recipient: data.recipient!, now: this.now() };
    if (row.status === 'route_selected') {
      const balance = await this.runtime.sourceBalance(q.rail, c);
      let notify = false;
      this.store.transaction(() => {
        if (this.store.get(id)?.status !== 'route_selected') return;
        const gate = this.gate(id, data, q);
        if (!gate.selected) { this.deny(id, [gate.explanation]); return; }
        this.runtime.reserve(id, q.rail, c, q, balance);
        this.store.db.prepare('UPDATE payments SET funds_locked = 1,reserved_at = ? WHERE id = ?').run(this.now(), id);
        this.move(id, 'funds_reserved');
        if (gate.decision === 'needs_approval' && data.approved === null) {
          this.store.db.prepare("INSERT INTO approvals(payment_id,nonce,expires_at,state) VALUES(?,?,?,'pending') ON CONFLICT(payment_id) DO UPDATE SET nonce=excluded.nonce,expires_at=excluded.expires_at,state='pending',actor=NULL,decided_at=NULL").run(id, randomBytes(16).toString('hex'), new Date(this.clock().getTime() + 900000).toISOString());
          this.move(id, 'pending_approval'); notify = true;
        }
      });
      if (notify) { try { await this.notifier.notify(this.notification(this.store.get(id)!)); this.store.audit(id, 'notification_sent', 'system', { channel: 'ntfy' }, this.now()); } catch { this.store.audit(id, 'notification_failed', 'system', { reason: 'Use /approvals' }, this.now()); } }
      return;
    }
    if (row.status === 'funds_reserved') {
      if (Date.parse(q.expires_at) <= Date.parse(this.now())) { this.store.transaction(() => { this.unlock(id); data.quote = null; this.save(id, data); this.move(id, 'route_selected', { reason: 'Expired quote must be repriced within the approved cost cap' }); }); return; }
      const gate = this.gate(id, data, q);
      if (!gate.selected || (gate.decision === 'needs_approval' && data.approved === null)) { this.store.transaction(() => this.deny(id, [gate.explanation])); return; }
      // Claim before I/O; a second worker can only reconcile this SAME operation key.
      this.store.transaction(() => { if (this.store.get(id)?.status !== 'funds_reserved') throw new WalletBusy(); this.move(id, 'in_transit'); });
      let out: RailExecution;
      try { out = await this.runtime.execute(q.rail, `${id}:${data.attempt}`, c, q); }
      catch (error) {
        if (error instanceof WalletBusy) { this.store.transaction(() => { this.store.transition(id, 'funds_reserved', 'signer_wait', 'system', { reason: 'Waiting for original wallet operation' }, this.now()); }); throw error; }
        if (error instanceof RouteFailure) out = error.outcome; else throw error;
      }
      if (out.status === 'failed' && safeFallback(data.intent, q, out, data.approved).safe) {
        this.store.transaction(() => { this.unlock(id); data.failedRails.push(q.rail); data.attempt++; data.quote = null; data.operation = null; this.save(id, data); this.move(id, 'route_selected', { reason: out.reason, safe_fallback: true }); }); return;
      }
      this.apply(id, data, out); return;
    }
    if (!data.operation) {
      // A crash may occur after the operation was persisted but before linking it to the payment.
      const existing = this.store.db.prepare('SELECT id FROM rail_operations WHERE operation_key = ?').get(`${id}:${data.attempt}`) as { id: string } | undefined;
      if (!existing) throw new Error('Interrupted execution with no durable provider operation; owner investigation required');
      data.operation = existing.id; this.save(id, data);
    }
    let out = data.returning ? await this.runtime.reverse(q.rail, data.operation) : await this.runtime.status(q.rail, data.operation);
    if (out.destination_rejected) { data.returning = true; this.save(id, data); this.store.audit(id, 'return_requested', 'system', { reason: 'Destination rejected payout' }, this.now()); out = await this.runtime.reverse(q.rail, data.operation); }
    this.apply(id, data, out);
  }
}
