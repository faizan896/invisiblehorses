import { sha256, stringToHex } from 'viem';
import type { Counterparty } from '../counterparty/profiles.js';
import type { RoutingIntent } from '../intent/routing.js';
import { decimal, minor, type PaymentIntent } from '../intent/schema.js';
import type { Policy } from '../policy/schema.js';
import { evaluate, type Evaluation, type PolicyHistory } from '../policy/engine.js';
import { RoutingRulesSchema } from '../policy/routing.js';
import type { RailId, RouteQuote } from '../rails/adapter.js';

export type RoutingInput = {
  intent: RoutingIntent; payer: Counterparty; recipient: Counterparty; policy: Policy; history: PolicyHistory;
  quotes: RouteQuote[]; unavailable: { rail: RailId; reason: string }[];
};
export type Alternative = { rail: RailId; eligible: boolean; reasons: string[]; quote: RouteQuote | null; policy: Evaluation | null };
export type RoutePlan = { decision: Evaluation['decision']; selected: RouteQuote | null; alternatives: Alternative[]; reasons: string[]; explanation: string };
export type Scoring = 'cheapest-by-deadline' | 'fastest' | 'most-certain' | ((quote: Readonly<RouteQuote>) => number);

export function preflight(input: Omit<RoutingInput, 'quotes' | 'unavailable'>): string[] {
  const { intent, payer, recipient, policy, history } = input;
  const rules = RoutingRulesSchema.parse(policy.routing ?? {});
  const reasons: string[] = [];
  if (!Number.isFinite(Date.parse(history.now)) || Date.parse(history.now) >= Date.parse(policy.expires_at)) reasons.push('Owner policy has expired or the clock is invalid');
  if (Date.parse(intent.deadline) <= Date.parse(history.now)) reasons.push('Payment deadline has already passed');
  const merchant = policy.allowed_merchants.find((m) => m.id === recipient.id);
  if (!merchant) reasons.push('Recipient is not in the owner merchant allowlist');
  if (merchant?.categories && !recipient.categories.some((c) => merchant.categories!.includes(c))) reasons.push('Owner counterparty category is not allowed');
  if (payer.kyb_status !== 'verified' || recipient.kyb_status !== 'verified') reasons.push('KYB gate: both test counterparty profiles must be verified');
  if (rules.blocked_countries.includes(payer.country) || rules.blocked_countries.includes(recipient.country)) reasons.push('Country is blocked by owner routing policy');
  return reasons;
}

/** Stable identity binds history to the owner-maintained destination, not an agent-supplied name. */
export function destinationAddress(recipient: Counterparty, quote: RouteQuote): `0x${string}` {
  if (quote.destination_form === 'wallet') return recipient.stablecoin_wallets[0]?.address ?? '0x0000000000000000000000000000000000000000';
  const destination = quote.destination_form === 'internal' ? recipient.internal_account : recipient.bank_accounts.find((a) => a.currency === quote.recipient_amount.currency && a.status === 'open');
  return `0x${sha256(stringToHex(JSON.stringify({ form: quote.destination_form, destination }))).slice(2, 42)}`;
}
export function policyIntent(intent: RoutingIntent, recipient: Counterparty, quote: RouteQuote): PaymentIntent {
  return {
    idempotency_key: intent.idempotency_key, payer: intent.payer, amount: quote.total_all_in_cost.amount,
    purpose: intent.purpose, metadata: intent.metadata,
    recipient: { id: recipient.id, name: recipient.name, address: destinationAddress(recipient, quote), category: recipient.categories[0] },
  };
}
function capabilities(input: RoutingInput, quote: RouteQuote): string[] {
  const { intent: i, payer: p, recipient: r, history, policy } = input;
  const rules = RoutingRulesSchema.parse(policy.routing ?? {});
  const reasons: string[] = [];
  const cost = minor(quote.total_all_in_cost.amount);
  if (minor(quote.recipient_amount.amount) !== minor(i.amount) || quote.recipient_amount.currency !== i.destination_currency) reasons.push('Quote would deliver a different recipient amount or currency');
  if (i.recipient_preferences.delivery !== 'any' && quote.destination_form !== i.recipient_preferences.delivery) reasons.push('Recipient requested a different funds form');
  if (quote.destination_form === 'internal' && (!p.internal_account || !r.internal_account)) reasons.push('Both parties need internal accounts');
  if (quote.destination_form === 'bank' && !r.bank_accounts.some((a) => a.currency === i.destination_currency && a.status === 'open')) reasons.push('Recipient has no open bank account for this currency');
  if (quote.destination_form === 'wallet' && !r.stablecoin_wallets.some((w) => w.chain_id === 84532)) reasons.push('Recipient has no compatible testnet wallet');
  if (quote.rail === 'ach-mock' && (p.country !== 'US' || r.country !== 'US' || i.destination_currency !== 'USD')) reasons.push('ACH corridor is US/USD only');
  if (quote.rail === 'wise-quote' && (p.country !== 'US' || !['US', 'MX', 'DE'].includes(r.country))) reasons.push('Bank corridor is unsupported in this test model');
  if (quote.rail === 'ledger' && p.preferred_currency !== i.destination_currency) reasons.push('Internal ledger currency pair is unsupported');
  if (quote.rail === 'usdc-base-sepolia' && i.recipient_preferences.avoid_stablecoins) reasons.push('Recipient explicitly avoids stablecoins');
  if (!rules.allowed_rails.includes(quote.rail)) reasons.push('Rail is excluded by owner policy');
  if (!quote.constraints.healthy) reasons.push('Rail is unhealthy');
  if (!quote.constraints.accepting_now) reasons.push('Bank/rail is outside its operating window or after cutoff');
  if (!quote.constraints.fx_pair_supported) reasons.push('FX pair is unsupported');
  if (cost > minor(quote.constraints.max_amount_usd)) reasons.push('Rail amount limit exceeded');
  if (cost > minor(quote.constraints.liquidity_usd)) reasons.push('Insufficient rail liquidity');
  if (Date.parse(quote.latest_available_at) > Date.parse(i.deadline)) reasons.push('Latest recipient funds availability misses the deadline');
  if (Date.parse(quote.expires_at) <= Date.parse(history.now) || Date.parse(quote.quoted_at) > Date.parse(history.now)) reasons.push('Quote is expired or dated in the future');
  if (minor(quote.total_fee_usd) > minor(i.max_fee)) reasons.push('All-in fees exceed max_fee');
  if (quote.certainty < rules.min_certainty) reasons.push('Quote certainty is below the owner minimum');
  if (i.reversibility_requirement === 'required' && quote.reversibility !== 'reversible') reasons.push('Required reversibility is not supported');
  if (quote.execution === 'quote-only') reasons.push('This provider supports quotes only, not execution');
  return reasons;
}
const names: Record<RailId, string> = { ledger: 'ledger', 'ach-mock': 'simulated ACH', 'usdc-base-sepolia': 'USDC via Base Sepolia', 'wise-quote': 'Wise-style bank rail' };
function compare(a: RouteQuote, b: RouteQuote, strategy: string) {
  const cost = minor(a.total_all_in_cost.amount) - minor(b.total_all_in_cost.amount);
  const time = Date.parse(a.expected_available_at) - Date.parse(b.expected_available_at);
  const certainty = b.certainty - a.certainty;
  const rank = { reversible: 0, conditional: 1, irreversible: 2 };
  const reversible = rank[a.reversibility] - rank[b.reversibility];
  const value = strategy === 'fastest' ? time || cost || certainty : strategy === 'refund_certainty' ? reversible || certainty || cost || time : cost || time || certainty;
  return value || (a.rail < b.rail ? -1 : a.rail > b.rail ? 1 : 0);
}
/** Pure deterministic gates first, scoring second; never invokes an LLM or a payment adapter. */
export function planRoutes(input: RoutingInput, scoring?: Scoring): RoutePlan {
  const hard = preflight(input), rules = RoutingRulesSchema.parse(input.policy.routing ?? {});
  const alternatives: Alternative[] = input.quotes.map((quote) => {
    const mapped = policyIntent(input.intent, input.recipient, quote);
    const allowed = input.policy.allowed_merchants.find((m) => m.id === input.recipient.id);
    mapped.recipient.category = input.recipient.categories.find((c) => !allowed?.categories || allowed.categories.includes(c));
    const policy = hard.length ? { decision: 'deny' as const, reasons: hard } : evaluate(mapped, input.policy, input.history, { routed: true });
    const reasons = [...hard, ...capabilities(input, quote), ...(policy.decision === 'deny' ? policy.reasons : [])];
    return { rail: quote.rail, quote, eligible: reasons.length === 0, reasons: [...new Set(reasons)], policy };
  });
  alternatives.push(...input.unavailable.map((u) => ({ rail: u.rail, quote: null, eligible: false, reasons: [...hard, u.reason], policy: null })));
  const strategy = typeof scoring === 'function' ? 'custom' : scoring === 'cheapest-by-deadline' ? 'lowest_cost' : scoring === 'most-certain' ? 'refund_certainty' : scoring ?? rules.strategy;
  const scores = new Map<Alternative, number>();
  const eligible = alternatives.filter(a => a.eligible && a.quote);
  if (typeof scoring === 'function') for (const a of eligible) {
    // A scorer receives a copy: it cannot mutate amounts or bypass eligibility gates.
    const score = scoring(structuredClone(a.quote!));
    if (!Number.isFinite(score)) throw new Error('Custom scoring must return a finite number; lower wins');
    scores.set(a, score);
  }
  const candidates = eligible.sort((a, b) => typeof scoring === 'function' ? scores.get(a)! - scores.get(b)! || a.rail.localeCompare(b.rail) : compare(a.quote!, b.quote!, strategy));
  const best = candidates[0];
  if (!best?.quote) {
    const reasons = hard.length ? hard : ['No eligible route satisfies owner policy and delivery constraints'];
    return { decision: 'deny', selected: null, alternatives, reasons, explanation: `No route chosen. ${reasons.join('; ')}. Alternatives: ${alternatives.map((a) => `${names[a.rail] ?? a.rail}: ${a.reasons.join('; ')}`).join(' | ')}` };
  }
  const q = best.quote;
  const reasons = [...best.policy!.reasons, `Selected using ${strategy}; all eligibility gates passed`];
  return {
    decision: best.policy!.decision, selected: q, alternatives, reasons,
    explanation: `Route chosen: ${names[q.rail] ?? q.rail}. Reason: ${strategy}, all-in $${decimal(minor(q.total_all_in_cost.amount))} USD; ${q.recipient_amount.amount} ${q.recipient_amount.currency} usable as ${q.destination_form} by ${q.expected_available_at}. Alternatives: ${alternatives.filter((a) => a !== best).map((a) => `${names[a.rail] ?? a.rail}: ${a.eligible ? `$${a.quote!.total_all_in_cost.amount} USD, eligible` : a.reasons.join('; ')}`).join(' | ')}`,
  };
}
