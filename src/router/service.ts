import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../audit/store.js';
import { Counterparties } from '../counterparty/profiles.js';
import { PaymentIntentV2Schema } from '../intent/routing.js';
import type { Policy } from '../policy/schema.js';
import type { RailId } from '../rails/adapter.js';
import { QuoteService } from '../rails/quotes.js';
import { AppError } from '../errors.js';
import { planRoutes, preflight, type RoutePlan } from './engine.js';

type PlanRow = { id: string; payer: string; intent: string; plan: string; policy_hash: string; created_at: string };
export class RoutingService {
  constructor(private readonly store: Store, private readonly profiles: Counterparties, private readonly quotes: QuoteService, private readonly policy: () => Policy, private readonly clock: () => Date = () => new Date()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS route_plans (
      id TEXT PRIMARY KEY, payer TEXT NOT NULL, intent TEXT NOT NULL, plan TEXT NOT NULL,
      policy_hash TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS route_plans_payer ON route_plans(payer, created_at);`);
  }
  async plan(input: unknown, authenticatedPayer: string, options: { excludePayment?: string; failedRails?: RailId[] } = {}) {
    const intent = PaymentIntentV2Schema.parse(input);
    if (intent.payer !== authenticatedPayer) throw new AppError(403, 'Payer does not match the authenticated agent');
    const payer = this.profiles.get(intent.payer), recipient = this.profiles.get(intent.recipient);
    const policy = this.policy(); const now = this.clock().toISOString();
    const history = this.store.history(now, options.excludePayment);
    const context = { intent, payer, recipient, policy, history };
    // Never call a quote provider for an identity/compliance/expiry denial.
    const gate = preflight(context);
    const result = gate.length ? { quotes: [], unavailable: this.quotes.railIds().map((rail) => ({ rail, reason: gate.join('; ') })) } : await this.quotes.quotes(intent, authenticatedPayer);
    // Quotes may take time, cross midnight, or span an owner policy edit. Decide on fresh state.
    const decidedAt = this.clock().toISOString(), currentPolicy = this.policy();
    const currentHistory = this.store.transaction(() => { this.store.expire(decidedAt); return this.store.history(decidedAt, options.excludePayment); });
    const excluded = result.quotes.filter((q) => options.failedRails?.includes(q.rail));
    const plan = planRoutes({ ...context, payer: this.profiles.get(intent.payer), recipient: this.profiles.get(intent.recipient), policy: currentPolicy, history: currentHistory, quotes: result.quotes.filter((q) => !options.failedRails?.includes(q.rail)), unavailable: [...result.unavailable, ...excluded.map((q) => ({ rail: q.rail, reason: 'Previous attempt on this rail failed safely; excluded from fallback' }))] });
    const id = randomUUID(), digest = createHash('sha256').update(JSON.stringify(currentPolicy)).digest('hex');
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO route_plans(id,payer,intent,plan,policy_hash,created_at) VALUES(?,?,?,?,?,?)').run(id, authenticatedPayer, JSON.stringify(intent), JSON.stringify(plan), digest, decidedAt);
      this.store.audit(null, 'route_planned', authenticatedPayer, { route_plan_id: id, intent, ...plan, policy_hash: digest }, decidedAt);
    });
    return { id, intent, ...plan, policy_hash: digest, created_at: decidedAt, execution_enabled: false, test_money_only: true };
  }
  get(id: string, payer: string) {
    const row = this.store.db.prepare('SELECT * FROM route_plans WHERE id = ? AND payer = ?').get(z.uuid().parse(id), payer) as PlanRow | undefined;
    if (!row) throw new AppError(404, 'Route plan not found');
    return { id: row.id, intent: PaymentIntentV2Schema.parse(JSON.parse(row.intent)), ...JSON.parse(row.plan) as RoutePlan, policy_hash: row.policy_hash, created_at: row.created_at, execution_enabled: false, test_money_only: true };
  }
}
