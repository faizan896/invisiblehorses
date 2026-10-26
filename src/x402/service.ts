import { randomBytes, randomUUID } from 'node:crypto';
import type { PaymentPayload, SettleResponse } from '@x402/core/types';
import type { StoreCore, PaymentRow } from '../audit/store-core.js';
import { fingerprint } from '../intent/fingerprint.js';
import { decimal, type PaymentIntent } from '../intent/schema.js';
import type { Policy } from '../policy/schema.js';
import type { Evaluation } from '../policy/engine.js';
import { ApprovalTokens } from '../approval/tokens.js';
import type { Notifier, ApprovalNotification } from '../approval/notifier.js';
import { AppError } from '../errors.js';
import { PaidResourceRequestSchema, type PaidResourceRequest } from './schema.js';
import { canonicalResourceUrl, evaluateX402, x402MerchantId } from './policy.js';
import { ExactProtocol, parseRequirements, type ParsedRequirements } from './protocol.js';

type Resource = { status: number; content_type: string; body: string };
type Context = { request: PaidResourceRequest; parsed?: ParsedRequirements; payload?: PaymentPayload; header?: string; sent?: boolean; resource?: Resource; receipt?: SettleResponse };
type Row = { id: string; payer: string; key: string; digest: string; state: string; context: string; reasons: string };
type Options = { store: StoreCore; policy: () => Policy; tokens: ApprovalTokens; notifier: Notifier; protocol: ExactProtocol; balanceMinor: () => Promise<number>; publicBaseUrl: string; fetcher?: typeof fetch; clock?: () => Date; beforeSend?: () => Promise<void>; allowLoopback?: boolean };
const terminal = ['completed', 'denied', 'rejected', 'expired', 'failed', 'interrupted'];
export class X402Service {
  readonly store: StoreCore;
  private busy = new Set<string>();
  constructor(private readonly o: Options) {
    this.store = o.store;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS resource_requests(id TEXT PRIMARY KEY,payer TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,context TEXT NOT NULL,reasons TEXT NOT NULL,UNIQUE(payer,key));
      CREATE TABLE IF NOT EXISTS test_rail_holds(payment_id TEXT PRIMARY KEY,source TEXT NOT NULL,amount_minor INTEGER NOT NULL,state TEXT NOT NULL);`);
  }
  private now() { return (this.o.clock?.() ?? new Date()).toISOString(); }
  private row(id: string) { return this.store.db.prepare('SELECT * FROM resource_requests WHERE id=?').get(id) as Row | undefined; }
  private context(r: Row) { return JSON.parse(r.context) as Context; }
  private save(id: string, state: string, c: Context, reasons: string[] = []) { this.store.db.prepare('UPDATE resource_requests SET state=?,context=?,reasons=? WHERE id=?').run(state, JSON.stringify(c), JSON.stringify(reasons), id); }
  private audit(id: string, event: string, details: unknown) { this.store.audit(this.store.get(id) ? id : null, event, 'x402', { resource_id: id, ...details as object }, this.now()); }
  private release(id: string, consumed = false) { this.store.db.prepare('UPDATE payments SET funds_locked=0 WHERE id=?').run(id); this.store.db.prepare("UPDATE test_rail_holds SET state=? WHERE payment_id=?").run(consumed ? 'consumed' : 'released', id); }
  private cleanup() {
    this.store.expire(this.now());
    const rows = this.store.db.prepare("SELECT r.* FROM resource_requests r JOIN payments p ON p.id=r.id WHERE p.status IN ('expired','rejected') AND r.state='pending_approval'").all() as Row[];
    for (const r of rows) { this.release(r.id); this.save(r.id, this.store.get(r.id)!.status, this.context(r), ['Owner approval expired or was rejected']); }
  }
  async initialize() {
    await this.o.protocol.assertTestnet();
    this.store.transaction(() => {
      this.cleanup();
      for (const r of this.store.db.prepare("SELECT * FROM resource_requests WHERE state IN ('inspecting','preparing')").all() as Row[]) {
        const c = this.context(r);
        this.save(r.id, 'interrupted', c, ['Interrupted before a durable authorization; owner investigation required, no replacement payment']);
        if (this.store.get(r.id)) this.store.transition(r.id, 'uncertain', 'x402_interrupted', 'system', { no_replacement: true }, this.now());
      }
    });
  }
  private apiSpent(exclude = '') {
    const history = this.store.history(this.now(), exclude);
    // Use exactly the common budget rules, restricted to API payment IDs.
    const start = new Date(this.now()); start.setUTCHours(0, 0, 0, 0); const end = new Date(+start + 86400000);
    const total = this.store.db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.status='completed' THEN p.amount_minor WHEN p.funds_locked=1 OR p.status IN ('pending_approval','uncertain') THEN p.amount_minor ELSE p.spent_minor END),0) n FROM payments p JOIN resource_requests r ON r.id=p.id WHERE p.id!=? AND p.reserved_at>=? AND p.reserved_at<?`).get(exclude, start.toISOString(), end.toISOString()) as { n: number };
    return { history, api_spent_today: decimal(total.n) };
  }
  private evaluation(c: Context, exclude = ''): Evaluation {
    return evaluateX402({ request: c.request, requirements: c.parsed!.selected, policy: this.o.policy(), ...this.apiSpent(exclude), allowLoopback: this.o.allowLoopback });
  }
  private allowedHost(url: string) {
    const rules = this.o.policy().x402, host = new URL(url).host;
    if (!rules?.allowed_hosts.some(h => h.host === host && rules.categories.includes(h.category))) throw new AppError(403, 'Resource host/category is not allowed by the owner x402 policy');
  }
  async request(input: unknown, payer: string) {
    const request = PaidResourceRequestSchema.parse(input);
    try { request.url = canonicalResourceUrl(request.url, this.o.allowLoopback); } catch { throw new AppError(400, 'Resource URL is not an allowed public HTTPS destination'); }
    this.allowedHost(request.url);
    const key = request.idempotency_key ?? `x402:${fingerprint({ payer, url: request.url })}`;
    request.idempotency_key = key;
    const digest = fingerprint(request);
    const claimed = this.store.transaction(() => {
      this.cleanup();
      const old = this.store.db.prepare('SELECT * FROM resource_requests WHERE payer=? AND key=?').get(payer, key) as Row | undefined;
      if (old) {
        if (old.digest !== digest) throw new AppError(409, 'Idempotency key belongs to a different resource request');
        this.audit(old.id, 'x402_retried', { cached: old.state === 'completed' }); return { id: old.id, fresh: false };
      }
      if (this.store.byKey(payer, key)) throw new AppError(409, 'Idempotency key already belongs to another payment');
      const id = randomUUID(); this.store.db.prepare("INSERT INTO resource_requests VALUES(?,?,?,?,'inspecting',?,'[]')").run(id, payer, key, digest, JSON.stringify({ request }));
      this.audit(id, 'x402_requested', { host: new URL(request.url).host, purpose: request.purpose }); return { id, fresh: true };
    });
    if (claimed.fresh) await this.inspect(claimed.id);
    else await this.advance(claimed.id);
    return this.get(claimed.id, payer);
  }
  private async fetch(url: string, header?: string) {
    // No ambient cookies/auth, redirects or arbitrary methods are forwarded.
    const response = await (this.o.fetcher ?? fetch)(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', ...(header ? { 'PAYMENT-SIGNATURE': header } : {}) } });
    if (response.status >= 300 && response.status < 400) throw new Error('Resource redirects are refused');
    return response;
  }
  private async resource(response: Response): Promise<Resource> {
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 262144) throw new Error('Resource exceeds 256 KiB'); chunks.push(item.value); } } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const type = response.headers.get('Content-Type') ?? 'text/plain';
    if (!/^(application\/(json|[^;]+\+json)|text\/)/i.test(type)) throw new Error('Only bounded text/JSON resources are supported');
    return { status: response.status, content_type: type, body: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  }
  private async inspect(id: string) {
    const r = this.row(id)!, c = this.context(r);
    try {
      const response = await this.fetch(c.request.url);
      if (response.ok) { c.resource = await this.resource(response); this.save(id, 'completed', c); this.audit(id, 'x402_free_resource', { status: response.status }); return; }
      c.parsed = parseRequirements(c.request.url, response); await response.body?.cancel();
      this.audit(id, 'x402_requirements_received', { host: new URL(c.request.url).host, network: c.parsed.selected.network, asset: c.parsed.selected.asset, amount_atomic: c.parsed.selected.amount });
      const balance = await this.o.balanceMinor();
      this.store.transaction(() => {
        const now = this.now(); this.cleanup(); const evaluation = this.evaluation(c);
        const source = `chain:84532:${this.o.protocol.address.toLowerCase()}:USDC`;
        const holds = (this.store.db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM test_rail_holds WHERE source=? AND state='active'").get(source) as { n: number }).n;
        if (c.parsed!.cents > balance - holds) { evaluation.decision = 'deny'; evaluation.reasons.push('Insufficient unreserved test USDC in the shared wallet'); }
        const status = evaluation.decision === 'deny' ? 'denied' : evaluation.decision === 'needs_approval' ? 'pending_approval' : 'funds_reserved';
        const host = new URL(c.request.url).host;
        const intent: PaymentIntent = { payer: r.payer, recipient: { id: x402MerchantId(host), name: host, address: c.parsed!.selected.payTo as `0x${string}`, category: this.o.policy().x402!.allowed_hosts.find(h => h.host === host)!.category }, amount: decimal(c.parsed!.cents), purpose: c.request.purpose, idempotency_key: r.key };
        const row: PaymentRow = { id, payer: r.payer, idempotency_key: r.key, fingerprint: r.digest, intent: JSON.stringify(intent), amount_minor: c.parsed!.cents, status, evaluation: JSON.stringify(evaluation), created_at: now, reserved_at: now, updated_at: now, transaction_hash: null, signed_transaction: null };
        this.store.insert(row); this.save(id, status === 'funds_reserved' ? 'ready' : status, c, evaluation.reasons);
        if (status !== 'denied') { this.store.db.prepare('UPDATE payments SET funds_locked=1 WHERE id=?').run(id); this.store.db.prepare("INSERT INTO test_rail_holds VALUES(?,?,?,'active')").run(id, source, row.amount_minor); }
        if (status === 'pending_approval') this.store.db.prepare("INSERT INTO approvals(payment_id,nonce,expires_at,state) VALUES(?,?,?,'pending')").run(id, randomBytes(16).toString('hex'), new Date(Date.parse(now) + 900000).toISOString());
        this.audit(id, 'x402_policy_evaluated', evaluation);
      });
      if (this.row(id)!.state === 'pending_approval') {
        try { await this.o.notifier.notify(this.notification(this.store.get(id)!)); this.audit(id, 'notification_sent', { channel: 'ntfy' }); }
        catch { this.audit(id, 'notification_failed', { fallback: '/approvals' }); }
      }
      await this.advance(id);
    } catch {
      const current = this.row(id)!;
      if (current.state !== 'inspecting') throw new AppError(503, 'Resource preparation unavailable; retry the same key');
      this.save(id, 'failed', c, ['Invalid or unavailable x402 requirements; no payment authorized']); this.audit(id, 'x402_inspection_failed', { no_payment: true });
    }
  }
  private async advance(id: string) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      this.store.transaction(() => this.cleanup());
      const r = this.row(id)!; if (terminal.includes(r.state) || ['pending_approval', 'inspecting', 'preparing'].includes(r.state)) return;
      const c = this.context(r);
      if (r.state === 'ready') {
        const permitted = this.store.transaction(() => {
          const e = this.evaluation(c, id), approved = this.store.approval(id)?.state === 'approved';
          if (e.decision === 'deny' || e.decision === 'needs_approval' && !approved) { this.release(id); this.save(id, 'denied', c, e.reasons); this.store.transition(id, 'denied', 'x402_policy_denied', 'system', e, this.now(), e); return false; }
          this.save(id, 'preparing', c); this.store.db.prepare('UPDATE payments SET reserved_at=? WHERE id=?').run(this.now(), id); return true;
        });
        if (!permitted) return;
        const signed = await this.o.protocol.create(c.parsed!);
        // Never let a signature leave this process before its exact bytes are persisted.
        c.payload = signed.payload; c.header = signed.header;
        this.store.transaction(() => { this.save(id, 'authorized', c); this.store.transition(id, 'in_transit', 'x402_authorization_persisted', 'system', { scheme: 'exact', network: c.parsed!.selected.network }, this.now()); });
      }
      if (c.receipt && c.resource) { await this.finish(id, c); return; }
      if (!c.header) return;
      await this.o.protocol.assertTestnet();
      if (!c.sent) {
        const permitted = this.store.transaction(() => {
          const e = this.evaluation(c, id);
          if (e.decision === 'deny' || e.decision === 'needs_approval' && this.store.approval(id)?.state !== 'approved') { this.release(id); this.save(id, 'denied', c, e.reasons); this.store.transition(id, 'denied', 'x402_policy_denied', 'system', e, this.now(), e); return false; }
          c.sent = true; this.save(id, 'authorized', c); this.store.db.prepare('UPDATE payments SET reserved_at=? WHERE id=?').run(this.now(), id); return true;
        });
        if (!permitted) return;
      }
      await this.o.beforeSend?.();
      const response = await this.fetch(c.request.url, c.header);
      if (!response.ok) { await response.body?.cancel(); throw new Error('Paid resource response unavailable; never create a replacement authorization'); }
      c.receipt = this.o.protocol.readReceipt(response, c.parsed!.selected);
      c.resource = await this.resource(response);
      this.store.transaction(() => { this.save(id, 'settling', c); this.store.db.prepare('UPDATE payments SET transaction_hash=? WHERE id=?').run(c.receipt!.transaction, id); this.store.transition(id, 'settled', 'x402_receipt_received', 'system', { receipt: c.receipt }, this.now()); });
      await this.finish(id, c);
    } catch {
      const r = this.row(id)!, c = this.context(r);
      this.store.transaction(() => {
        const interrupted = r.state === 'preparing';
        this.save(id, interrupted ? 'interrupted' : c.receipt ? 'settling' : 'uncertain', c, [interrupted ? 'Signing interrupted; owner investigation required; no replacement' : 'Outcome unconfirmed; funds remain reserved; retries reuse the stored authorization']);
        this.store.transition(id, 'uncertain', 'x402_unconfirmed', 'system', { no_replacement: true }, this.now());
      });
    } finally { this.busy.delete(id); }
  }
  private async finish(id: string, c: Context) {
    await this.o.protocol.confirmReceipt(c.receipt!, c.parsed!.selected, c.payload);
    this.store.transaction(() => { this.release(id, true); this.save(id, 'completed', c); this.store.transition(id, 'completed', 'x402_completed', 'system', { receipt: c.receipt, resource_status: c.resource!.status }, this.now()); });
  }
  private notification(row: PaymentRow): ApprovalNotification {
    const a = this.store.approval(row.id)!;
    const link = (action: 'approve' | 'reject') => { const url = new URL('/approval-actions', this.o.publicBaseUrl); url.searchParams.set('token', this.o.tokens.sign({ v: 1, payment_id: row.id, action, nonce: a.nonce, expires_at: a.expires_at })); return url.toString(); };
    return { paymentId: row.id, intent: JSON.parse(row.intent), expiresAt: a.expires_at, approveUrl: link('approve'), rejectUrl: link('reject') };
  }
  decideIfOwned(token: string) {
    const now = this.now(), p = this.o.tokens.verify(token, now), r = this.row(p.payment_id); if (!r) return undefined;
    return this.store.transaction(() => {
      this.cleanup(); const a = this.store.approval(r.id);
      if (!a || a.nonce !== p.nonce || a.expires_at !== p.expires_at) throw new AppError(403, 'Approval does not match stored request');
      if (a.state !== 'pending' || this.row(r.id)!.state !== 'pending_approval') throw new AppError(409, 'Approval is no longer pending');
      this.store.db.prepare('UPDATE approvals SET state=?,actor=?,decided_at=? WHERE payment_id=?').run(p.action === 'approve' ? 'approved' : 'rejected', 'owner:approval-token', now, r.id);
      const c = this.context(r), e = this.evaluation(c, r.id);
      const status = p.action === 'reject' ? 'rejected' : e.decision === 'deny' ? 'denied' : 'funds_reserved';
      if (status !== 'funds_reserved') this.release(r.id);
      this.save(r.id, status === 'funds_reserved' ? 'ready' : status, c, e.reasons);
      this.store.transition(r.id, status, 'x402_owner_decision', 'owner:approval-token', { action: p.action, ...e }, now, e);
      return { id: r.id, status, evaluation: e };
    });
  }
  async get(id: string, payer: string) {
    this.store.transaction(() => this.cleanup());
    const r = this.row(id); if (!r || r.payer !== payer) throw new AppError(404, 'Resource request not found');
    const c = this.context(r), payment = this.store.get(id);
    return { id, url: c.request.url, status: payment?.status ?? r.state, evaluation: { decision: payment ? (JSON.parse(payment.evaluation) as Evaluation).decision : r.state === 'completed' ? 'allow' : 'deny', reasons: JSON.parse(r.reasons) as string[] }, resource: r.state === 'completed' ? c.resource : undefined, receipt: r.state === 'completed' ? c.receipt : undefined, test_money_only: true };
  }
  async tick() {
    this.store.transaction(() => this.cleanup());
    // Ambiguous delivery is retried only on the explicit original request. Confirming a
    // saved receipt or resuming owner-approved work does not mint another authorization.
    for (const r of this.store.db.prepare("SELECT * FROM resource_requests WHERE state IN ('ready','authorized','settling')").all() as Row[]) await this.advance(r.id);
  }
}
