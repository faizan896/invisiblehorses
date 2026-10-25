import { QuoteOnlyAdapter, type QuoteContext } from './adapter.js';
import { modeledQuote, principalUsd, ceilRatio } from './pricing.js';
import { decimal } from '../intent/schema.js';
import { nextPayout } from './calendar.js';
export class UsdcQuoteAdapter extends QuoteOnlyAdapter {
  readonly id = 'usdc-base-sepolia' as const;
  async quote(c: QuoteContext) {
    if (c.intent.recipient_preferences.avoid_stablecoins) return null;
    if (!c.payer.stablecoin_wallets.length || !c.recipient.stablecoin_wallets.length) return null;
    const bank = c.intent.recipient_preferences.delivery === 'bank' || (c.intent.recipient_preferences.delivery === 'any' && c.recipient.payment_preferences[0] === 'bank');
    if (bank && !c.recipient.bank_accounts.some((b) => b.currency === c.intent.destination_currency)) return null;
    if (!bank && c.intent.destination_currency !== 'USD') return null;
    const principal = principalUsd(c);
    const onramp = ceilRatio(principal, 5n, 10000n);
    const offramp = bank ? 100 + ceilRatio(principal, 8n, 10000n) : 0;
    const spread = c.intent.destination_currency === 'USD' ? 0 : ceilRatio(principal, 10n, 10000n);
    const network = 2;
    const confirmed = new Date(Date.parse(c.now) + 12000).toISOString();
    return this.bounded(modeledQuote(this.id, c, {
      pricing: 'modeled', execution: 'base-sepolia', form: bank ? 'bank' : 'wallet',
      expected: bank ? nextPayout(confirmed) : confirmed,
      certainty: bank ? 0.94 : 0.99, reversibility: 'irreversible',
      fees: [
        { kind: 'onramp', cents: onramp, description: 'MODELED test onramp fee' },
        { kind: 'network', cents: network, description: 'MODELED Base Sepolia gas allowance in USD; not a live gas quote' },
        { kind: 'fx_spread', cents: spread, description: 'MODELED destination FX spread' },
        { kind: 'offramp', cents: offramp, description: 'MODELED test offramp/payout fee' },
      ],
      steps: [
        { kind: 'onramp', description: 'MODELED USD → test USDC funding leg', simulated: true, fee_usd: decimal(onramp) },
        { kind: 'network', description: 'USDC transfer on Base Sepolia only (chain 84532)', simulated: false, fee_usd: decimal(network) },
        ...(bank ? [
          { kind: 'fx' as const, description: `MODELED USDC → ${c.intent.destination_currency} conversion`, simulated: true, fee_usd: decimal(spread) },
          { kind: 'offramp' as const, description: 'MODELED payout to the recipient’s requested bank form; bank hours apply', simulated: true, fee_usd: decimal(offramp) },
        ] : []),
      ],
      explanation: bank ? 'Testnet USDC transfer plus explicitly MODELED onramp, FX, offramp and bank availability. Chain confirmation alone is not delivery of bank funds.' : 'Base Sepolia test USDC wallet delivery; onramp and gas pricing are explicitly MODELED.',
    }), c);
  }
}
