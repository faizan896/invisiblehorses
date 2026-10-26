import { QuoteOnlyAdapter, type QuoteContext } from './adapter.js';
import { bankWindow } from './calendar.js';
import { modeledQuote, principalUsd, ceilRatio } from './pricing.js';
import { decimal } from '../intent/schema.js';
export class AchMockAdapter extends QuoteOnlyAdapter {
  readonly id = 'ach-mock' as const;
  async quote(c: QuoteContext) {
    if (c.payer.country !== 'US' || c.recipient.country !== 'US' || c.intent.destination_currency !== 'USD') return null;
    if (!c.payer.bank_accounts.some((b) => b.country === 'US' && b.currency === 'USD') || !c.recipient.bank_accounts.some((b) => b.country === 'US' && b.currency === 'USD')) return null;
    const window = bankWindow(c.now);
    const fee = Math.min(500, 25 + ceilRatio(principalUsd(c), 10n, 10000n));
    return this.bounded(modeledQuote(this.id, c, {
      pricing: 'mock', execution: 'simulated', form: 'bank', expected: window.expected_at, latest: window.latest_at,
      certainty: 0.9, reversibility: 'conditional', acceptingNow: window.accepting_now,
      fees: [{ kind: 'bank', cents: fee, description: 'Simulated US ACH fee' }],
      steps: [{ kind: 'bank', description: `SIMULATED ACH; processing ${window.processing_at}; 1–2 US banking days`, simulated: true, fee_usd: decimal(fee) }],
      explanation: 'SIMULATED US-only ACH. 16:00 America/New_York cutoff; weekends and US banking holidays excluded. This rail cannot directly deliver MXN to Mexico.',
    }), c);
  }
}
