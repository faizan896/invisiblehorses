import { describe, expect, it } from 'vitest';
import { Counterparties } from '../src/counterparty/profiles.js';
import { PaymentIntentV2Schema } from '../src/intent/routing.js';
import { QuoteService } from '../src/rails/quotes.js';
import { PolicySchema } from '../src/policy/schema.js';
import { planRoutes, preflight } from '../src/router/engine.js';
import { RoutingRulesSchema } from '../src/policy/routing.js';
import { decimal, minor } from '../src/intent/schema.js';
import type { RouteQuote } from '../src/rails/adapter.js';

const clock = '2026-10-27T14:00:00.000Z';
const catalog = () => Counterparties.load('examples/counterparties.json');
function intent(overrides = {}) { return PaymentIntentV2Schema.parse({ idempotency_key: 'router-001', payer: 'research-agent-07', recipient: 'dataco', amount: '10', destination_currency: 'USD', deadline: '2026-10-29T23:00:00Z', purpose: 'invoice', max_fee: '1000', reversibility_requirement: 'none', recipient_preferences: { delivery: 'any' }, ...overrides }); }
function policy() { return PolicySchema.parse({ max_per_payment: 20000, max_per_day: 50000, new_merchant_max: 20000, require_approval_above: 100, expires_at: '2030-01-01T00:00:00Z', allowed_merchants: [{ id: 'dataco', categories: ['data'] }, { id: 'norte', categories: ['manufacturing'] }], routing: {} }); }
async function setup(overrides = {}, now = clock) {
  const i = intent(overrides), p = catalog();
  const raw = await new QuoteService(p, undefined, () => new Date(now)).quotes(i, i.payer);
  return { intent: i, payer: p.get(i.payer), recipient: p.get(i.recipient), policy: policy(), history: { now, spent_today: '0', paid_merchants: [] as string[] }, quotes: raw.quotes, unavailable: raw.unavailable };
}
function addFee(q: RouteQuote, cents: number) {
  q.fees_usd[0]!.amount = decimal(minor(q.fees_usd[0]!.amount) + cents);
  q.steps[0]!.fee_usd = decimal(minor(q.steps[0]!.fee_usd) + cents);
  q.total_fee_usd = decimal(minor(q.total_fee_usd) + cents);
  q.total_all_in_cost.amount = decimal(minor(q.total_all_in_cost.amount) + cents);
}
describe('router gates and scoring: tests written before implementation', () => {
  it('chooses the lowest all-in eligible cost and retains alternatives/explanation', async () => {
    const result = planRoutes(await setup());
    expect(result.selected?.rail).toBe('ledger'); expect(result.decision).toBe('allow');
    expect(result.alternatives).toHaveLength(4); expect(result.explanation).toMatch(/Route chosen:.*ledger/i);
  });
  it('routes the IDENTICAL 250,000 MXN intent via USDC Monday night and bank Tuesday morning', async () => {
    const input = { recipient: 'norte', amount: '250000', destination_currency: 'MXN', recipient_preferences: { delivery: 'bank' } };
    const monday = await setup(input, '2026-10-26T22:00:00.000Z');
    const tuesday = await setup(input, '2026-10-27T14:00:00.000Z');
    expect(monday.intent).toEqual(tuesday.intent);
    const a = planRoutes(monday), b = planRoutes(tuesday);
    expect(a.selected?.rail).toBe('usdc-base-sepolia'); expect(b.selected?.rail).toBe('wise-quote');
    expect(a.decision).toBe('needs_approval'); expect(b.decision).toBe('needs_approval');
    expect(a.alternatives.find((r) => r.rail === 'wise-quote')!.reasons.join()).toMatch(/cutoff|operating|accepting/i);
  });
  it('runs merchant/category/expiry/compliance gates before scoring any quote', async () => {
    const a = await setup(); a.policy.allowed_merchants = [{ id: 'other' }];
    expect(preflight(a).join()).toMatch(/allowlist/i); expect(planRoutes(a).selected).toBeNull();
    const b = await setup(); b.recipient.categories = ['compute']; expect(preflight(b).join()).toMatch(/category/i);
    const c = await setup(); c.policy.expires_at = clock; expect(preflight(c).join()).toMatch(/expired/i);
    const d = await setup(); d.recipient.kyb_status = 'pending'; expect(preflight(d).join()).toMatch(/KYB/);
    const e = await setup(); e.payer.kyb_status = 'rejected'; expect(planRoutes(e).decision).toBe('deny');
  });
  it('honors owner blocked countries and allowed rails', async () => {
    const a = await setup({ recipient: 'norte', destination_currency: 'MXN' });
    a.policy.routing = RoutingRulesSchema.parse({ blocked_countries: ['MX'] });
    expect(planRoutes(a).decision).toBe('deny');
    const b = await setup(); b.policy.routing = RoutingRulesSchema.parse({ allowed_rails: ['ach-mock'] });
    expect(planRoutes(b).selected?.rail).toBe('ach-mock');
  });
  it('excludes insufficient liquidity, amount limits, unsupported FX and unhealthy rails before score', async () => {
    for (const [field, value] of [['liquidity_usd', '1'], ['max_amount_usd', '1'], ['fx_pair_supported', false], ['healthy', false], ['accepting_now', false]] as const) {
      const a = await setup(); a.quotes = [a.quotes[0]!];
      Object.assign(a.quotes[0]!.constraints, { [field]: value });
      const result = planRoutes(a); expect(result.selected).toBeNull(); expect(result.alternatives[0]!.eligible).toBe(false);
    }
  });
  it('checks deadlines against latest recipient availability, not chain confirmation', async () => {
    const a = await setup({ deadline: '2026-10-27T14:00:05Z' });
    a.quotes = a.quotes.filter((q) => q.rail !== 'ledger');
    expect(planRoutes(a).selected).toBeNull();
    expect(planRoutes(a).alternatives.every((q) => q.reasons.some((r) => /deadline/i.test(r)))).toBe(true);
  });
  it('enforces exact max_fee boundaries including all on/offramp and FX fees', async () => {
    const a = await setup({ max_fee: '0.26' }); a.quotes = a.quotes.filter((q) => q.rail === 'ach-mock');
    expect(planRoutes(a).selected?.rail).toBe('ach-mock');
    a.intent.max_fee = '0.25'; expect(planRoutes(a).selected).toBeNull();
  });
  it('filters recipient capabilities, requested form, corridor and mismatched delivery amounts', async () => {
    const a = await setup(); a.recipient.internal_account = undefined; a.quotes = [a.quotes[0]!];
    expect(planRoutes(a).selected).toBeNull();
    const b = await setup({ recipient_preferences: { delivery: 'bank' } });
    b.recipient.bank_accounts.forEach((account) => { account.status = 'closed'; });
    expect(planRoutes(b).selected).toBeNull();
    const c = await setup(); c.quotes = c.quotes.filter((q) => q.rail === 'ach-mock'); c.recipient.country = 'MX';
    expect(planRoutes(c).selected).toBeNull();
    const d = await setup(); d.quotes = [d.quotes[0]!]; d.quotes[0]!.recipient_amount.amount = '9';
    expect(planRoutes(d).selected).toBeNull();
  });
  it('enforces hard policy and daily reservations on all-in USD cost before choosing', async () => {
    const a = await setup(); a.policy.max_per_day = '9.99'; expect(planRoutes(a).decision).toBe('deny');
    const b = await setup(); b.policy.max_per_payment = '10'; b.quotes = b.quotes.filter((q) => q.rail !== 'ledger');
    expect(planRoutes(b).selected).toBeNull();
    const c = await setup(); c.policy.max_per_day = '10'; c.history.spent_today = '0.01'; expect(planRoutes(c).selected).toBeNull();
  });
  it('honors required reversibility and explicit avoidance of stablecoins', async () => {
    const a = await setup({ reversibility_requirement: 'required' }); expect(planRoutes(a).selected?.rail).toBe('ledger');
    a.quotes = a.quotes.filter((q) => q.rail !== 'ledger'); expect(planRoutes(a).selected).toBeNull();
    const b = await setup({ recipient_preferences: { delivery: 'any', avoid_stablecoins: true } });
    expect(planRoutes(b).alternatives.some((r) => r.rail === 'usdc-base-sepolia' && r.eligible)).toBe(false);
  });
  it('supports fastest and refund-certainty strategies without relaxing gates', async () => {
    const a = await setup(); a.quotes = a.quotes.filter((q) => q.rail !== 'ledger');
    addFee(a.quotes.find((q) => q.rail === 'usdc-base-sepolia')!, 200);
    expect(planRoutes(a).selected?.rail).toBe('ach-mock');
    a.policy.routing = RoutingRulesSchema.parse({ strategy: 'fastest' }); expect(planRoutes(a).selected?.rail).toBe('usdc-base-sepolia');
    a.policy.routing = RoutingRulesSchema.parse({ strategy: 'refund_certainty' }); expect(planRoutes(a).selected?.rail).toBe('wise-quote');
  });
  it('rejects expired/future quotes, past deadlines, and sandbox quote-only execution', async () => {
    const a = await setup(); a.quotes = [a.quotes[0]!]; a.quotes[0]!.expires_at = clock; expect(planRoutes(a).selected).toBeNull();
    const b = await setup(); b.quotes = [b.quotes[0]!]; b.quotes[0]!.quoted_at = '2026-10-27T14:00:01Z'; expect(planRoutes(b).selected).toBeNull();
    const c = await setup({ deadline: clock }); expect(preflight(c).join()).toMatch(/deadline/i);
    const d = await setup(); d.quotes = [d.quotes[0]!]; d.quotes[0]!.execution = 'quote-only'; expect(planRoutes(d).selected).toBeNull();
  });
  it('is pure/deterministic, including stable tie breaking and no LLM decisions', async () => {
    const a = await setup(); const before = JSON.stringify(a);
    expect(planRoutes(a)).toEqual(planRoutes(a)); expect(JSON.stringify(a)).toBe(before);
  });
});
