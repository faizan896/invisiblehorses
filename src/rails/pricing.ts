import { randomUUID } from 'node:crypto';
import { decimal, minor } from '../intent/schema.js';
import type { QuoteContext, RailId, RouteQuote } from './adapter.js';
import { RouteQuoteSchema } from './adapter.js';

// Explicit, deterministic test pricing. These are not live market exchange rates.
export const MODEL_FX = { USD: 10000n, MXN: 170000n, EUR: 9200n } as const;
export function ceilRatio(value: number, numerator: bigint, denominator: bigint) {
  const result = (BigInt(value) * numerator + denominator - 1n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Money exceeds exact integer range');
  return Number(result);
}
export function principalUsd(context: QuoteContext) { return ceilRatio(minor(context.intent.amount), 10000n, MODEL_FX[context.intent.destination_currency]); }
type Options = {
  pricing: RouteQuote['pricing']; execution: RouteQuote['execution'];
  form: RouteQuote['destination_form']; expected: string; latest?: string;
  certainty: number; reversibility: RouteQuote['reversibility'];
  fees: { kind: RouteQuote['fees_usd'][number]['kind']; cents: number; description: string }[];
  steps: RouteQuote['steps']; explanation: string; acceptingNow?: boolean;
};
export function modeledQuote(rail: RailId, context: QuoteContext, options: Options): RouteQuote {
  const principal = principalUsd(context);
  const fees = options.fees.reduce((total, fee) => total + fee.cents, 0);
  return RouteQuoteSchema.parse({
    id: randomUUID(), rail, test_money_only: true, pricing: options.pricing, execution: options.execution,
    quoted_at: context.now, expires_at: new Date(Date.parse(context.now) + 300000).toISOString(),
    recipient_amount: { amount: decimal(minor(context.intent.amount)), currency: context.intent.destination_currency },
    principal_usd: decimal(principal), fees_usd: options.fees.map((f) => ({ kind: f.kind, amount: decimal(f.cents), description: f.description })),
    total_fee_usd: decimal(fees), total_all_in_cost: { amount: decimal(principal + fees), currency: 'USD' },
    expected_available_at: options.expected, latest_available_at: options.latest ?? options.expected,
    certainty: options.certainty, reversibility: options.reversibility, destination_form: options.form,
    steps: options.steps, constraints: { healthy: true, accepting_now: options.acceptingNow ?? true, liquidity_usd: '1000000', max_amount_usd: '1000000', fx_pair_supported: true },
    explanation: options.explanation,
  });
}
