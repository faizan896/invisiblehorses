import { Counterparties } from '../src/counterparty/profiles.js';
import { QuoteService } from '../src/rails/quotes.js';

console.log('QUOTE DEMO: test profiles and MODELED/MOCK pricing; no transfers or external APIs.');
const service = new QuoteService(Counterparties.load('examples/counterparties.json'));
for (const [recipient, amount, currency, delivery] of [['dataco', '10', 'USD', 'any'], ['norte', '250000', 'MXN', 'bank']]) {
  const result = await service.quotes({
    idempotency_key: `quote-demo-${recipient}`, payer: 'research-agent-07', recipient, amount,
    destination_currency: currency, deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
    purpose: 'demo invoice', max_fee: '1000', reversibility_requirement: 'none', recipient_preferences: { delivery },
    metadata: { invoice_id: 'quote-demo' },
  }, 'research-agent-07');
  console.log(`${result.recipient.name}: ${amount} ${currency} requested`);
  console.table(result.quotes.map((q) => ({ rail: q.rail, allInUSD: q.total_all_in_cost.amount, feesUSD: q.total_fee_usd, usableBy: q.expected_available_at, pricing: q.pricing, form: q.destination_form })));
  console.log('Unavailable rails:', result.unavailable.map((v) => v.rail).join(', ') || 'none');
}
