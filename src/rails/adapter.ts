import { z } from 'zod';
import type { Counterparty } from '../counterparty/profiles.js';
import { CurrencySchema, type RoutingIntent } from '../intent/routing.js';
import { MoneySchema, minor } from '../intent/schema.js';

export const RailIdSchema = z.enum(['ledger', 'ach-mock', 'usdc-base-sepolia', 'wise-quote']);
export type RailId = z.infer<typeof RailIdSchema>;
export const Money = z.strictObject({ amount: MoneySchema, currency: CurrencySchema });
export const RouteQuoteSchema = z.strictObject({
  id: z.uuid(), rail: RailIdSchema, test_money_only: z.literal(true),
  pricing: z.enum(['modeled', 'mock', 'sandbox']), execution: z.enum(['internal-test-ledger', 'simulated', 'base-sepolia', 'quote-only']),
  quoted_at: z.iso.datetime(), expires_at: z.iso.datetime(),
  recipient_amount: Money, principal_usd: MoneySchema,
  fees_usd: z.array(z.strictObject({ kind: z.enum(['fx_spread', 'network', 'onramp', 'offramp', 'bank', 'service']), amount: MoneySchema, description: z.string().min(1) })),
  total_fee_usd: MoneySchema, total_all_in_cost: z.strictObject({ amount: MoneySchema, currency: z.literal('USD') }),
  expected_available_at: z.iso.datetime(), latest_available_at: z.iso.datetime(),
  certainty: z.number().min(0).max(1), reversibility: z.enum(['irreversible', 'conditional', 'reversible']),
  destination_form: z.enum(['internal', 'bank', 'wallet']),
  steps: z.array(z.strictObject({ kind: z.enum(['internal', 'bank', 'onramp', 'network', 'fx', 'offramp']), description: z.string().min(1), simulated: z.boolean(), fee_usd: MoneySchema })).min(1),
  constraints: z.strictObject({ healthy: z.boolean(), accepting_now: z.boolean(), liquidity_usd: MoneySchema, max_amount_usd: MoneySchema, fx_pair_supported: z.boolean() }),
  explanation: z.string().min(1),
}).superRefine((q, ctx) => {
  const fees = q.fees_usd.reduce((sum, fee) => sum + minor(fee.amount), 0);
  const stepFees = q.steps.reduce((sum, step) => sum + minor(step.fee_usd), 0);
  if (fees !== minor(q.total_fee_usd) || fees !== stepFees || minor(q.principal_usd) + fees !== minor(q.total_all_in_cost.amount)) ctx.addIssue({ code: 'custom', message: 'Quote fees, steps and all-in source total must reconcile exactly' });
  if (minor(q.recipient_amount.amount) <= 0) ctx.addIssue({ code: 'custom', message: 'Recipient amount must be positive' });
  if (Date.parse(q.expires_at) <= Date.parse(q.quoted_at) || Date.parse(q.expected_available_at) < Date.parse(q.quoted_at) || Date.parse(q.latest_available_at) < Date.parse(q.expected_available_at)) ctx.addIssue({ code: 'custom', message: 'Invalid quote validity or availability window' });
});
export type RouteQuote = z.infer<typeof RouteQuoteSchema>;
export type QuoteContext = { intent: RoutingIntent; payer: Counterparty; recipient: Counterparty; now: string };
export type RailExecution = { id: string; status: 'pending' | 'settled' | 'failed' | 'returned'; irreversible: boolean; recipient_usable: boolean; funds_may_have_left?: boolean; fx_exposure?: boolean; destination_rejected?: boolean; reason?: string; refunded_usd?: string; charged_fee_usd?: string; transaction_hash?: `0x${string}`; return_pending?: boolean };
export interface RailExecutionBackend {
  liquidity(rail: RailId, context: QuoteContext): Promise<string>;
  execute(rail: RailId, key: string, context: QuoteContext, quote: RouteQuote): Promise<RailExecution>;
  status(rail: RailId, id: string): Promise<RailExecution>;
  reverse(rail: RailId, id: string): Promise<RailExecution>;
}
export interface RailAdapter {
  readonly id: RailId;
  quote(context: QuoteContext): Promise<RouteQuote | null>;
  execute(key: string, context: QuoteContext, quote: RouteQuote): Promise<RailExecution>;
  status(id: string): Promise<RailExecution>;
  reverse(id: string): Promise<RailExecution>;
}
/** New adapters expose quotes first. The lifecycle milestone explicitly enables execution. */
export abstract class QuoteOnlyAdapter implements RailAdapter {
  constructor(protected readonly backend?: RailExecutionBackend) {}
  abstract readonly id: RailId;
  abstract quote(context: QuoteContext): Promise<RouteQuote | null>;
  async execute(key: string, context: QuoteContext, quote: RouteQuote): Promise<RailExecution> { if (!this.backend) throw new Error('Multi-rail execution is not enabled until the lifecycle milestone'); return this.backend.execute(this.id, key, context, quote); }
  async status(id: string): Promise<RailExecution> { if (!this.backend) throw new Error('Multi-rail execution is not enabled until the lifecycle milestone'); return this.backend.status(this.id, id); }
  async reverse(id: string): Promise<RailExecution> { if (!this.backend) throw new Error('Multi-rail execution is not enabled until the lifecycle milestone'); return this.backend.reverse(this.id, id); }
  protected async bounded(quote: RouteQuote, context: QuoteContext) {
    if (this.backend) quote.constraints.liquidity_usd = await this.backend.liquidity(this.id, context);
    return quote;
  }
}
