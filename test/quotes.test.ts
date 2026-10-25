import { describe, expect, it } from 'vitest';
import { Counterparties, CounterpartySchema } from '../src/counterparty/profiles.js';
import { PaymentIntentV2Schema } from '../src/intent/routing.js';
import { QuoteService } from '../src/rails/quotes.js';
import { RouteQuoteSchema, type QuoteContext } from '../src/rails/adapter.js';
import { LedgerAdapter } from '../src/rails/ledger.js';
import { WiseSandboxQuoteAdapter, wiseAdapter } from '../src/rails/wise-quote.js';
import { bankWindow } from '../src/rails/calendar.js';
import { minor } from '../src/intent/schema.js';

const now = '2026-10-27T14:00:00.000Z';
const profiles = () => Counterparties.load('examples/counterparties.json');
const input = (overrides = {}) => PaymentIntentV2Schema.parse({
  idempotency_key: 'quote-invoice-001', payer: 'research-agent-07', recipient: 'dataco', amount: '10',
  destination_currency: 'USD', deadline: '2026-11-06T23:00:00Z', purpose: 'dataset access', max_fee: '100',
  reversibility_requirement: 'none', recipient_preferences: { delivery: 'any', avoid_stablecoins: false },
  metadata: { invoice_id: '001' }, ...overrides,
});
function context(overrides = {}): QuoteContext { const intent = input(overrides); const p = profiles(); return { intent, payer: p.get(intent.payer), recipient: p.get(intent.recipient), now }; }
function service() { return new QuoteService(profiles(), undefined, () => new Date(now)); }

describe('full destination-denominated payment intents and owner counterparties', () => {
  it('validates every full intent field and forbids agent rail selection', () => {
    expect(input().destination_currency).toBe('USD');
    for (const extra of [{ rail: 'usdc-base-sepolia' }, { amount: 10 }, { amount: '1e3' }, { max_fee: '-1' }, { deadline: 'tomorrow' }, { destination_currency: 'ZZZ' }, { reversibility_requirement: 'magic' }]) expect(() => input(extra)).toThrow();
  });
  it('seeds Norte with Mexican bank/MXN preference and an optional testnet wallet', () => {
    const norte = profiles().get('norte');
    expect(norte.name).toBe('Norte Manufacturing'); expect(norte.country).toBe('MX');
    expect(norte.preferred_currency).toBe('MXN'); expect(norte.payment_preferences[0]).toBe('bank');
    expect(norte.bank_accounts[0]!.currency).toBe('MXN'); expect(norte.stablecoin_wallets[0]!.chain_id).toBe(84532);
  });
  it('rejects mainnet wallets and real-looking bank profiles; never mutates the owner catalog', () => {
    const p = profiles(); const a = p.get('dataco'); a.name = 'tampered'; expect(p.get('dataco').name).toBe('DataCo');
    expect(() => CounterpartySchema.parse({ ...a, test_profile: false })).toThrow();
    expect(() => CounterpartySchema.parse({ ...a, stablecoin_wallets: [{ chain_id: 8453, address: a.stablecoin_wallets[0]!.address }] })).toThrow();
    expect(() => CounterpartySchema.parse({ ...a, bank_accounts: [{ ...a.bank_accounts[0], reference: 'real-bank-account' }] })).toThrow();
    expect(() => p.get('unknown')).toThrow(/not found/);
  });
});
describe('normalized multi-rail quotes', () => {
  it('quotes all four compatible rails in one validated cost/availability shape', async () => {
    const result = await service().quotes(input(), 'research-agent-07');
    expect(result.quotes.map((q) => q.rail)).toEqual(['ledger', 'ach-mock', 'usdc-base-sepolia', 'wise-quote']);
    expect(result.unavailable).toHaveLength(0); expect(result.execution_enabled).toBe(false);
    for (const q of result.quotes) {
      expect(RouteQuoteSchema.safeParse(q).success).toBe(true);
      expect(q.total_all_in_cost.currency).toBe('USD');
      expect(minor(q.total_fee_usd)).toBe(q.fees_usd.reduce((total, fee) => total + minor(fee.amount), 0));
      expect(minor(q.total_all_in_cost.amount)).toBe(minor(q.principal_usd) + minor(q.total_fee_usd));
      expect(q.recipient_amount).toEqual({ amount: '10.00', currency: 'USD' });
    }
    const ledger = result.quotes.find((q) => q.rail === 'ledger')!;
    expect(ledger.total_fee_usd).toBe('0.00'); expect(ledger.expected_available_at).toBe(now);
    expect(result.quotes.find((q) => q.rail === 'ach-mock')!.pricing).toBe('mock');
    expect(result.quotes.find((q) => q.rail === 'wise-quote')!.explanation).toMatch(/MOCK/);
  });
  it('models every USDC funding/payout/FX leg and recipient availability for Norte', async () => {
    const result = await service().quotes(input({ recipient: 'norte', amount: '250000', destination_currency: 'MXN', recipient_preferences: { delivery: 'bank' } }), 'research-agent-07');
    expect(result.quotes.map((q) => q.rail)).toEqual(['usdc-base-sepolia', 'wise-quote']);
    const q = result.quotes.find((q) => q.rail === 'usdc-base-sepolia')!;
    expect(q.principal_usd).toBe('14705.89');
    expect(q.fees_usd.map((f) => f.kind)).toEqual(['onramp', 'network', 'fx_spread', 'offramp']);
    expect(q.steps.find((s) => s.kind === 'network')!.simulated).toBe(false);
    expect(q.steps.filter((s) => s.kind !== 'network').every((s) => s.simulated)).toBe(true);
    expect(q.destination_form).toBe('bank');
    expect(Date.parse(q.expected_available_at)).toBeGreaterThan(Date.parse(now) + 12000);
    expect(result.unavailable.find((v) => v.rail === 'ach-mock')).toBeDefined();
  });
  it('does not pretend USD tokens are MXN wallet funds', async () => {
    const result = await service().quotes(input({ recipient: 'norte', destination_currency: 'MXN', recipient_preferences: { delivery: 'wallet' } }), 'research-agent-07');
    expect(result.quotes.some((q) => q.rail === 'usdc-base-sepolia')).toBe(false);
  });
  it('rejects forged payers and unknown counterparties', async () => {
    await expect(service().quotes(input({ payer: 'another-agent' }), 'research-agent-07')).rejects.toThrow(/Payer/);
    await expect(service().quotes(input({ recipient: 'unknown' }), 'research-agent-07')).rejects.toThrow(/not found/);
  });
  it('honors requested delivery form and explicit stablecoin avoidance', async () => {
    const result = await service().quotes(input({ recipient_preferences: { delivery: 'bank', avoid_stablecoins: true } }), 'research-agent-07');
    expect(result.quotes.map((q) => q.rail)).toEqual(['ach-mock', 'wise-quote']);
    expect(result.quotes.every((q) => q.destination_form === 'bank')).toBe(true);
  });
  it('rejects internally inconsistent source totals and availability windows', async () => {
    const q = (await service().quotes(input(), 'research-agent-07')).quotes.find((v) => v.rail === 'ach-mock')!;
    expect(() => RouteQuoteSchema.parse({ ...q, total_fee_usd: '0' })).toThrow(/reconcile/);
    expect(() => RouteQuoteSchema.parse({ ...q, total_all_in_cost: { amount: '10', currency: 'USD' } })).toThrow(/reconcile/);
    expect(() => RouteQuoteSchema.parse({ ...q, latest_available_at: now })).toThrow(/window/);
  });
  it('keeps isolated quote-only adapters blocked without a runtime backend', async () => {
    const rail = new LedgerAdapter(); const c = context(); const quote = (await rail.quote(c))!;
    await expect(rail.execute('key', c, quote)).rejects.toThrow(/not enabled/);
    await expect(rail.status('unknown')).rejects.toThrow(/not enabled/);
    await expect(rail.reverse('unknown')).rejects.toThrow(/not enabled/);
  });
});
describe('simulated ACH banking calendar', () => {
  it('includes exact cutoff, business days and DST rather than adding 24 hours blindly', () => {
    expect(bankWindow('2026-10-30T19:59:00Z').accepting_now).toBe(true);
    expect(bankWindow('2026-10-30T20:00:00Z').accepting_now).toBe(false);
    expect(bankWindow('2026-10-30T19:59:00Z').expected_at).toBe('2026-11-02T21:00:00.000Z');
    expect(bankWindow('2026-10-30T20:00:00Z').expected_at).toBe('2026-11-03T21:00:00.000Z');
  });
  it('skips US banking holidays and weekends', () => {
    expect(bankWindow('2026-11-10T15:00:00Z').expected_at).toBe('2026-11-12T21:00:00.000Z');
    expect(bankWindow('2026-11-26T15:00:00Z').accepting_now).toBe(false);
    expect(bankWindow('2026-11-26T15:00:00Z').expected_at).toBe('2026-11-30T21:00:00.000Z');
    expect(bankWindow('2026-10-31T15:00:00Z').expected_at).toBe('2026-11-03T21:00:00.000Z');
  });
});
describe('verified Wise sandbox quote contract, simulated HTTP transport', () => {
  const body = () => ({
    id: 'c3b82c02-2c9e-4f62-a32b-6178616039ea', expirationTime: '2026-10-27T14:05:00Z',
    sourceCurrency: 'USD', targetCurrency: 'MXN', rate: 17, payOut: 'BANK_TRANSFER',
    paymentOptions: [{ disabled: false, payIn: 'BANK_TRANSFER', payOut: 'BANK_TRANSFER', sourceCurrency: 'USD', targetCurrency: 'MXN', sourceAmount: 101, targetAmount: 1700, estimatedDelivery: '2026-10-28T12:00:00Z', price: { total: { value: { amount: 1, currency: 'USD' } } } }],
  });
  it('uses the documented 2026Q4 sandbox host and inclusive price.total pricing', async () => {
    let url = ''; let sent: RequestInit | undefined;
    const rail = new WiseSandboxQuoteAdapter('synthetic-sandbox-token', '101', async (input, init) => { url = String(input); sent = init; return Response.json(body()); });
    const q = (await rail.quote(context({ recipient: 'norte', amount: '1700', destination_currency: 'MXN' })))!;
    expect(url).toBe('https://api.wise-sandbox.com/2026Q4/profiles/101/quotes');
    expect(JSON.parse(sent!.body as string)).toMatchObject({ sourceCurrency: 'USD', targetCurrency: 'MXN', sourceAmount: null, targetAmount: 1700, preferredPayIn: 'BANK_TRANSFER' });
    expect(q.total_all_in_cost.amount).toBe('101.00'); expect(q.principal_usd).toBe('100.00'); expect(q.total_fee_usd).toBe('1.00');
    expect(q.pricing).toBe('sandbox'); expect(q.execution).toBe('quote-only');
  });
  it('never silently turns a configured sandbox error into a fake live quote', async () => {
    const rail = new WiseSandboxQuoteAdapter('synthetic-sandbox-token', '101', async () => new Response('not authorized', { status: 401 }));
    await expect(rail.quote(context({ recipient: 'norte', destination_currency: 'MXN' }))).rejects.toThrow(/unavailable/);
    expect(() => wiseAdapter('configured-token')).toThrow(/PROFILE/);
    expect(wiseAdapter()).not.toBeInstanceOf(WiseSandboxQuoteAdapter);
  });
  it('rejects disabled, expired, mismatched or incomplete provider prices', async () => {
    const changes = [
      (b: ReturnType<typeof body>) => { b.paymentOptions[0]!.disabled = true; },
      (b: ReturnType<typeof body>) => { b.expirationTime = '2026-01-01T00:00:00Z'; },
      (b: ReturnType<typeof body>) => { b.paymentOptions[0]!.targetAmount = 1699; },
      (b: ReturnType<typeof body>) => { b.paymentOptions[0]!.price.total.value.amount = 102; },
    ];
    for (const change of changes) {
      const b = body(); change(b);
      const rail = new WiseSandboxQuoteAdapter('synthetic-token', '101', async () => Response.json(b));
      await expect(rail.quote(context({ recipient: 'norte', amount: '1700', destination_currency: 'MXN' }))).rejects.toThrow();
    }
  });
});
