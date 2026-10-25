import { QuoteOnlyAdapter, type QuoteContext } from './adapter.js';
import { modeledQuote, principalUsd, ceilRatio } from './pricing.js';
import { decimal } from '../intent/schema.js';
import { bankWindow } from './calendar.js';
import { z } from 'zod';
import { minor } from '../intent/schema.js';
import { RouteQuoteSchema, type RailExecutionBackend } from './adapter.js';

/** Credential-free, labelled quote model. Sandbox support is enabled only against verified API docs. */
export class WiseMockQuoteAdapter extends QuoteOnlyAdapter {
  readonly id = 'wise-quote' as const;
  async quote(c: QuoteContext) {
    if (!c.recipient.bank_accounts.some((b) => b.currency === c.intent.destination_currency)) return null;
    const p = principalUsd(c);
    const service = 50 + ceilRatio(p, 5n, 10000n);
    const spread = c.intent.destination_currency === 'USD' ? 0 : ceilRatio(p, 5n, 10000n);
    const window = bankWindow(c.now);
    return this.bounded(modeledQuote(this.id, c, {
      pricing: 'mock', execution: 'simulated', form: 'bank', expected: window.expected_at, latest: window.latest_at,
      certainty: 0.96, reversibility: 'conditional', acceptingNow: window.accepting_now,
      fees: [
        { kind: 'service', cents: service, description: 'MOCK Wise-style sandbox service fee; not a Wise price' },
        { kind: 'fx_spread', cents: spread, description: 'MOCK FX spread; not a live rate' },
      ],
      steps: [
        { kind: 'fx', description: `MOCK USD → ${c.intent.destination_currency} conversion`, simulated: true, fee_usd: decimal(spread) },
        { kind: 'bank', description: 'MOCK bank payout, including MXN to a Mexican test bank profile', simulated: true, fee_usd: decimal(service) },
      ],
      explanation: 'MOCK Wise-style quote: no sandbox token configured. All FX, fees and bank delivery are simulated; no Wise payment API is called.',
    }), c);
  }
}

const ProviderAmount = z.union([z.number().finite().nonnegative(), z.string()]).transform(String).pipe(z.string().regex(/^\d{1,10}(?:\.\d{1,6})?$/));
function providerCents(value: string) {
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  return Number((units + 9999n) / 10000n);
}
const SandboxQuote = z.object({
  id: z.uuid(), expirationTime: z.iso.datetime(), sourceCurrency: z.literal('USD'), targetCurrency: z.string(),
  rate: z.number().finite().positive(), payOut: z.literal('BANK_TRANSFER'),
  paymentOptions: z.array(z.object({
    disabled: z.boolean(), payIn: z.string(), payOut: z.string(),
    sourceCurrency: z.literal('USD'), targetCurrency: z.string(), sourceAmount: ProviderAmount, targetAmount: ProviderAmount,
    estimatedDelivery: z.iso.datetime(),
    price: z.object({ total: z.object({ value: z.object({ amount: ProviderAmount, currency: z.literal('USD').optional() }) }) }),
  })),
});
/** Verified against https://docs.wise.com/api-reference/quote/quotecreate (2026Q4). Quotes only. */
export class WiseSandboxQuoteAdapter extends QuoteOnlyAdapter {
  readonly id = 'wise-quote' as const;
  private readonly profileId: string;
  constructor(private readonly token: string, profileId: string, private readonly fetcher: typeof fetch = fetch) {
    super(); this.profileId = z.string().regex(/^[1-9]\d{0,18}$/).parse(profileId);
    if (!token) throw new Error('Wise sandbox token missing');
  }
  async quote(c: QuoteContext) {
    if (!c.recipient.bank_accounts.some((b) => b.currency === c.intent.destination_currency)) return null;
    // The production hostname is deliberately not configurable or used anywhere.
    const response = await this.fetcher(`https://api.wise-sandbox.com/2026Q4/profiles/${this.profileId}/quotes`, {
      method: 'POST', signal: AbortSignal.timeout(10000), redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceCurrency: 'USD', targetCurrency: c.intent.destination_currency, sourceAmount: null, targetAmount: Number(c.intent.amount), payOut: 'BANK_TRANSFER', preferredPayIn: 'BANK_TRANSFER' }),
    });
    if (!response.ok) throw new Error('Wise sandbox quote unavailable');
    const body = SandboxQuote.parse(await response.json());
    const option = body.paymentOptions.find((o) => !o.disabled && o.payIn === 'BANK_TRANSFER' && o.payOut === body.payOut && o.targetCurrency === c.intent.destination_currency);
    if (!option || body.targetCurrency !== c.intent.destination_currency || providerCents(option.targetAmount) !== minor(c.intent.amount)) throw new Error('No matching enabled Wise payment option');
    const total = providerCents(option.sourceAmount), fee = providerCents(option.price.total.value.amount);
    if (fee > total || Date.parse(body.expirationTime) <= Date.parse(c.now)) throw new Error('Invalid or expired Wise quote');
    const q = modeledQuote(this.id, c, {
      pricing: 'sandbox', execution: 'quote-only', form: 'bank', expected: option.estimatedDelivery,
      certainty: 0.95, reversibility: 'conditional',
      fees: [{ kind: 'service', cents: fee, description: 'Wise sandbox price.total.value.amount, including disclosed taxes and fees' }],
      steps: [{ kind: 'bank', description: 'Wise SANDBOX quote only; no transfer or bank payment is executed', simulated: true, fee_usd: decimal(fee) }],
      explanation: `Wise SANDBOX 2026Q4 quote at provider rate ${body.rate}. All-in source amount includes quote pricing; FX spread is not separately disclosed. This adapter never creates or funds a Wise transfer.`,
    });
    return RouteQuoteSchema.parse({ ...q, id: body.id, expires_at: body.expirationTime, principal_usd: decimal(total - fee), total_all_in_cost: { amount: decimal(total), currency: 'USD' } });
  }
}

export function wiseAdapter(token?: string, profileId?: string, backend?: RailExecutionBackend) {
  if (!token) return new WiseMockQuoteAdapter(backend);
  if (!profileId) throw new Error('WISE_SANDBOX_PROFILE_ID is required when a sandbox token is configured');
  return new WiseSandboxQuoteAdapter(token, profileId);
}
