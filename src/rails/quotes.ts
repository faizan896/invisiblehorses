import { PaymentIntentV2Schema } from '../intent/routing.js';
import { Counterparties } from '../counterparty/profiles.js';
import { AppError } from '../errors.js';
import { RouteQuoteSchema, type RailAdapter, type RailId } from './adapter.js';
import { LedgerAdapter } from './ledger.js';
import { AchMockAdapter } from './ach-mock.js';
import { UsdcQuoteAdapter } from './usdc-quote.js';
import { wiseAdapter } from './wise-quote.js';
export function defaultAdapters(wiseToken?: string, wiseProfileId?: string): RailAdapter[] {
  return [new LedgerAdapter(), new AchMockAdapter(), new UsdcQuoteAdapter(), wiseAdapter(wiseToken, wiseProfileId)];
}
export class QuoteService {
  constructor(private readonly profiles: Counterparties, private readonly adapters: RailAdapter[] = defaultAdapters(), private readonly clock: () => Date = () => new Date()) {}
  railIds() { return this.adapters.map((a) => a.id); }
  async quotes(input: unknown, authenticatedPayer: string) {
    const intent = PaymentIntentV2Schema.parse(input);
    if (intent.payer !== authenticatedPayer) throw new AppError(403, 'Payer does not match the authenticated agent');
    const payer = this.profiles.get(intent.payer), recipient = this.profiles.get(intent.recipient);
    const now = this.clock().toISOString();
    const results = await Promise.all(this.adapters.map(async (adapter) => {
      try {
        const quote = await adapter.quote({ intent, payer, recipient, now });
        if (quote && intent.recipient_preferences.delivery !== 'any' && quote.destination_form !== intent.recipient_preferences.delivery) return { rail: adapter.id, reason: 'Rail does not deliver the form requested by the recipient' };
        return quote ? { quote: RouteQuoteSchema.parse(quote), rail: adapter.id } : { rail: adapter.id, reason: 'Recipient, currency or corridor is unsupported on this rail' };
      } catch { return { rail: adapter.id, reason: 'Quote unavailable; provider failed or returned invalid pricing' }; }
    }));
    return {
      intent, recipient, quotes: results.flatMap((r) => r.quote ? [r.quote] : []),
      unavailable: results.filter((r) => !r.quote).map((r) => ({ rail: r.rail as RailId, reason: r.reason! })),
      test_money_only: true, execution_enabled: false,
    };
  }
}
