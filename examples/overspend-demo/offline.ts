import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../../src/audit/store.js';
import { loadPolicy } from '../../src/policy/loader.js';
import { PaymentService } from '../../src/executor/service.js';
import { UnifiedPaymentService } from '../../src/executor/unified.js';
import { RailRuntime } from '../../src/executor/rail-runtime.js';
import { ApprovalTokens } from '../../src/approval/tokens.js';
import { PaymentIntentV2Schema } from '../../src/intent/routing.js';
import { Counterparties } from '../../src/counterparty/profiles.js';
import { QuoteService, defaultAdapters } from '../../src/rails/quotes.js';
import { RoutingService } from '../../src/router/service.js';
import { MockTestnetExecutor, RecordingNotifier } from '../support/mock.js';

console.log('OFFLINE DEMO: internal TEST ledger, MOCK testnet executor and MOCK ntfy. No external calls.');
const store = new Store(':memory:'), executor = new MockTestnetExecutor(), notifier = new RecordingNotifier();
const profiles = Counterparties.load('examples/counterparties.json'), payer = 'research-agent-07';
const policy = () => loadPolicy('policies/example.yaml');
const tokens = new ApprovalTokens(randomBytes(32).toString('hex')), origin = 'https://offline.example.test';
const legacy = new PaymentService(store, policy, tokens, notifier, executor, origin);
const runtime = new RailRuntime(store, profiles, payer, { executor, address: profiles.get(payer).stablecoin_wallets[0]!.address, balanceMinor: async () => 10000 });
const quotes = new QuoteService(profiles, defaultAdapters(undefined, undefined, runtime));
const routing = new RoutingService(store, profiles, quotes, policy);
const service = new UnifiedPaymentService(store, legacy, profiles, routing, runtime, policy, tokens, notifier, origin);
const input = (amount: string, key: string) => PaymentIntentV2Schema.parse({ payer, idempotency_key: key, amount, recipient: 'dataco', destination_currency: 'USD', deadline: new Date(Date.now() + 86400000).toISOString(), max_fee: '0', reversibility_requirement: 'required', recipient_preferences: { delivery: 'internal' }, purpose: 'dataset access' });
async function runUntil(id: string, expected: string) {
  for(let i=0;i<20;i++) { if(service.get(id).status===expected)return; await service.tick(); }
  assert.equal(service.get(id).status,expected);
}
try {
  await service.initialize();
  const firstInput=input('5','demo-allowed');
  const first=await service.request(firstInput,payer); await runUntil(first.id,'completed');
  console.log('(a) $5 completed through the common lifecycle [INTERNAL TEST LEDGER]');
  const second=await service.request(input('45','demo-approval'),payer); await runUntil(second.id,'pending_approval');
  console.log('(b) $45 awaits human approval [MOCK push; offline harness acts as owner]');
  service.decide(new URL(notifier.notifications[0]!.approveUrl).searchParams.get('token')!);
  await runUntil(second.id,'completed');
  const denied=await service.request(input('100','demo-overspend'),payer); await runUntil(denied.id,'denied');
  console.log('(c) $150 cumulative attempt denied:',service.get(denied.id).evaluation.reasons.join('; '));
  const retry=await service.request(firstInput,payer); await service.tick(); assert.equal(retry.id,first.id);
  assert.equal(runtime.balance('ledger:test:treasury'),5000); assert.equal(runtime.balance('ledger:test:dataco'),5000);
  assert.equal((store.db.prepare('SELECT COUNT(*) n FROM rail_operations').get() as {n:number}).n,2); assert.equal(executor.prepared,0);
  console.log('(d) Retry returned the original ID; exactly two ledger debits, no chain transfers.');
  console.log('Offline demo passed. Real testnet and phone acceptance evidence: docs/milestone-1.md.');
} finally { store.close(); }
