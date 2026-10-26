import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRouter, Counterparties, defaultAdapters, PolicySchema, PaymentIntentV2Schema, AchMockAdapter, QuoteOnlyAdapter, modeledQuote, type QuoteContext, type RouteQuote } from '../src/index.js';

const profiles = new Counterparties(JSON.parse(readFileSync(new URL('../examples/counterparties.json', import.meta.url), 'utf8')));
function setup(now = '2026-10-27T14:00:00Z', scoring: Parameters<typeof createRouter>[0]['scoring'] = 'cheapest-by-deadline', rails = defaultAdapters()) {
  const policy = PolicySchema.parse({ max_per_payment: '30000', max_per_day: '50000', new_merchant_max: '30000', require_approval_above: '100', expires_at: '2030-01-01T00:00:00Z', allowed_merchants: [{ id: 'dataco' }, { id: 'norte' }], routing: {} });
  const router = createRouter({ rails, scoring, context: intent => ({ payer: profiles.get(intent.payer), recipient: profiles.get(intent.recipient), policy, history: { now, spent_today: '0', paid_merchants: [] } }) });
  return { router, policy };
}
const intent = (overrides = {}) => PaymentIntentV2Schema.parse({ payer: 'research-agent-07', recipient: 'dataco', amount: '10', destination_currency: 'USD', idempotency_key: 'scenario-1', purpose: 'invoice', max_fee: '100', deadline: '2026-11-06T23:00:00Z', reversibility_requirement: 'none', ...overrides });
const bank = { recipient_preferences: { delivery: 'bank' } };
const rejected = (plan: Awaited<ReturnType<ReturnType<typeof createRouter>['plan']>>, rail: string) => plan.alternatives.find(a => a.rail === rail)?.reasons.join('; ');

describe('payroute standalone routing scenarios', () => {
  it('US domestic ACH before cutoff, after cutoff, on a weekend and a banking holiday', async () => {
    const cases = [['2026-10-27T14:00:00Z', true], ['2026-10-27T22:00:00Z', false], ['2026-10-31T14:00:00Z', false], ['2026-11-26T15:00:00Z', false]] as const;
    for (const [now, open] of cases) {
      const plan = await setup(now, undefined, [new AchMockAdapter()]).router.plan(intent({ ...bank, deadline: '2026-12-05T00:00:00Z' }));
      expect(!!plan.selected, now).toBe(open);
      if (!open) expect(rejected(plan, 'ach-mock')).toMatch(/cutoff|operating window/);
    }
  });
  it('routes identical Monday-night USD→MXN via USDC and Tuesday-morning via mock bank', async () => {
    const input = intent({ ...bank, recipient: 'norte', amount: '250000', destination_currency: 'MXN' });
    expect((await setup('2026-10-26T22:00:00Z').router.plan(input)).selected?.rail).toBe('usdc-base-sepolia');
    expect((await setup().router.plan(input)).selected?.rail).toBe('wise-quote');
  });
  it('prefers reversibility for refunds without overriding hard requirements', async () => {
    const plan = await setup(undefined, 'most-certain').router.plan(intent({ reversibility_requirement: 'preferred' }));
    expect(plan.selected?.rail).toBe('ledger');
    expect((await setup().router.plan(intent({ reversibility_requirement: 'required', ...bank }))).selected).toBeNull();
  });
  it('respects a recipient refusing stablecoins and the all-in fee ceiling', async () => {
    const p = await setup('2026-10-26T22:00:00Z').router.plan(intent({ ...bank, recipient_preferences: { delivery: 'bank', avoid_stablecoins: true } }));
    expect(p.selected).toBeNull();
    const capped = await setup().router.plan(intent({ ...bank, max_fee: '0.25' }));
    expect(capped.selected).toBeNull(); expect(rejected(capped, 'ach-mock')).toMatch(/max_fee/);
  });
  it('keeps unhealthy rails in the rejection explanation and never scores them', async () => {
    const rails = defaultAdapters().map(adapter => { const quote = adapter.quote.bind(adapter); adapter.quote = async c => { const q = await quote(c); if (q) q.constraints.healthy = false; return q; }; return adapter; });
    let called = 0;
    const { router } = setup(undefined, () => { called++; return 0; }, rails);
    const plan = await router.plan(intent()); expect(plan.selected).toBeNull(); expect(called).toBe(0); expect(rejected(plan, 'ledger')).toMatch(/unhealthy/);
  });
  it('supports a custom RTP mock adapter operating 24/7, including weekends', async () => {
    class RtpMock extends QuoteOnlyAdapter {
      readonly id = 'rtp-mock';
      async quote(c: QuoteContext) { return modeledQuote(this.id, c, { pricing: 'mock', execution: 'simulated', form: 'bank', expected: new Date(Date.parse(c.now) + 1000).toISOString(), certainty: 0.98, reversibility: 'irreversible', fees: [], steps: [{ kind: 'bank', description: 'MOCK RTP; no bank API', simulated: true, fee_usd: '0' }], explanation: 'MOCK 24/7 RTP domestic route' }); }
    }
    const { router, policy } = setup('2026-10-31T14:00:00Z', 'fastest', [new AchMockAdapter(), new RtpMock()]);
    policy.routing!.allowed_rails.push('rtp-mock');
    expect((await router.plan(intent(bank))).selected?.rail).toBe('rtp-mock');
  });
  it('custom scoring ranks eligible quotes only and rejects invalid scores', async () => {
    const score = (q: RouteQuote) => q.rail === 'wise-quote' ? -1 : 1;
    expect((await setup(undefined, score).router.plan(intent(bank))).selected?.rail).toBe('wise-quote');
    await expect(setup(undefined, () => NaN).router.plan(intent())).rejects.toThrow(/finite/);
    expect((await setup(undefined, 'fastest').router.plan(intent(bank))).selected?.rail).toBe('usdc-base-sepolia');
    const maliciousScore = (q: RouteQuote) => { q.total_all_in_cost.amount = '0'; return 0; };
    expect((await setup(undefined, maliciousScore).router.plan(intent())).selected?.total_all_in_cost.amount).not.toBe('0');
  });
  it('exposes normalized quotes and refuses execution without an application backend', async () => {
    const rails = defaultAdapters(), { router } = setup(undefined, undefined, rails);
    const quotes = await router.quote(intent()); expect(quotes).toHaveLength(4);
    expect(quotes.every(q => q.test_money_only && q.total_all_in_cost.currency === 'USD')).toBe(true);
    await expect(rails[0]!.execute('key', {} as QuoteContext, quotes[0]!)).rejects.toThrow(/backend/);
    expect((await router.plan(intent())).explanation).toMatch(/Route chosen/);
  });
});
