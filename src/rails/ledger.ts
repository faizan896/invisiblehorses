import { QuoteOnlyAdapter, type QuoteContext } from './adapter.js';
import { modeledQuote } from './pricing.js';
export class LedgerAdapter extends QuoteOnlyAdapter {
  readonly id = 'ledger' as const;
  async quote(c: QuoteContext) {
    if (!c.payer.internal_account || !c.recipient.internal_account || c.payer.preferred_currency !== c.intent.destination_currency) return null;
    return this.bounded(modeledQuote(this.id, c, {
      pricing: 'modeled', execution: 'internal-test-ledger', form: 'internal', expected: c.now,
      certainty: 1, reversibility: 'reversible', fees: [],
      steps: [{ kind: 'internal', description: 'Atomic transfer between internal test accounts', simulated: true, fee_usd: '0.00' }],
      explanation: 'Internal test-ledger transfer: instant and free. No external money movement.',
    }), c);
  }
}
