import assert from 'node:assert/strict';
import { Store } from '../src/audit/store.js';
import { Counterparties } from '../src/counterparty/profiles.js';
import { QuoteService } from '../src/rails/quotes.js';
import { RoutingService } from '../src/router/service.js';
import { loadPolicy } from '../src/policy/loader.js';
console.log('ROUTING DEMO: identical hypothetical intent, fictional profiles and modeled/mock pricing; no execution.');
const store = new Store(':memory:'), profiles = Counterparties.load('examples/counterparties.json');
let now = new Date('2026-10-26T22:00:00Z');
const quotes = new QuoteService(profiles, undefined, () => now);
const router = new RoutingService(store, profiles, quotes, () => loadPolicy('policies/corporate.example.yaml'), () => now);
const intent = { idempotency_key: 'same-hypothetical-invoice', payer: 'research-agent-07', recipient: 'norte', amount: '250000', destination_currency: 'MXN', deadline: '2026-10-29T23:00:00Z', purpose: 'manufacturing invoice', max_fee: '1000', reversibility_requirement: 'none', recipient_preferences: { delivery: 'bank' }, metadata: { invoice_id: 'norte-001' } };
try {
  const monday = await router.plan(intent, intent.payer);
  now = new Date('2026-10-27T14:00:00Z'); const tuesday = await router.plan(intent, intent.payer);
  assert.equal(monday.selected?.rail, 'usdc-base-sepolia'); assert.equal(tuesday.selected?.rail, 'wise-quote');
  assert.equal(store.list().length, 0);
  console.table([{ time: 'Monday after cutoff', rail: monday.selected.rail, allInUSD: monday.selected.total_all_in_cost.amount, decision: monday.decision }, { time: 'Tuesday morning', rail: tuesday.selected.rail, allInUSD: tuesday.selected.total_all_in_cost.amount, decision: tuesday.decision }]);
  console.log(monday.explanation); console.log(tuesday.explanation);
  console.log('Both decisions and alternatives were recorded. Neither plan created or paid a payment.');
} finally { store.close(); }
