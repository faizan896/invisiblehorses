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

const present = process.argv.includes('--present');
const color = { cyan: '\u001b[1;36m', green: '\u001b[1;32m', yellow: '\u001b[1;33m', red: '\u001b[1;31m', dim: '\u001b[2m', reset: '\u001b[0m' };
const pause = async (ms: number) => { if (present) await new Promise<void>((resolve) => setTimeout(resolve, ms)); };
function scene(title: string) {
  if (!present) return;
  process.stdout.write('\u001b[2J\u001b[H');
  console.log(`${color.cyan}RAILGATE${color.reset}  |  ${title}`);
  console.log(`${color.dim}OFFLINE: test ledger, mock chain + notifications. No external calls.${color.reset}\n`);
}
function report(plain: string, styled: string, tone: keyof typeof color = 'green') {
  console.log(present ? `${color[tone]}${styled}${color.reset}` : plain);
}
if (present) {
  scene('Spending controls for AI agents');
  console.log('An agent requests a payment. Owner rules decide what can happen.\n');
  console.log('Hard limits       $100 / payment   |   $100 / day');
  console.log('Human approval    Above $20');
  console.log('Retries           Reuse the original payment');
  await pause(2200);
} else console.log('OFFLINE DEMO: internal TEST ledger, MOCK testnet executor and MOCK ntfy. No external calls.');
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
  scene('1 / 4  A small payment');
  if (present) console.log('Request: pay DataCo $5.00\n');
  const firstInput=input('5','demo-allowed');
  const first=await service.request(firstInput,payer); await runUntil(first.id,'completed');
  report('(a) $5 completed through the common lifecycle [INTERNAL TEST LEDGER]', 'ALLOWED  $5.00 completed through the test ledger.');
  if (present) console.log('\nBelow the approval threshold. No owner action needed.');
  await pause(2600);
  scene('2 / 4  Human approval');
  if (present) console.log('Request: pay DataCo $45.00\n');
  const second=await service.request(input('45','demo-approval'),payer); await runUntil(second.id,'pending_approval');
  report('(b) $45 awaits human approval [MOCK push; offline harness acts as owner]', 'PAUSED  Owner approval required. Funds have not been sent.', 'yellow');
  await pause(2200);
  if (present) console.log(`\n${color.dim}SIMULATED OWNER: Approve (offline harness, not a phone action).${color.reset}`);
  service.decide(new URL(notifier.notifications[0]!.approveUrl).searchParams.get('token')!);
  await runUntil(second.id,'completed');
  if (present) report('', '\nCOMPLETED  $45.00 after the simulated approval.');
  await pause(2200);
  scene('3 / 4  The daily budget is a hard ceiling');
  if (present) console.log('Already spent: $50.00   |   Next request: $100.00\n');
  const denied=await service.request(input('100','demo-overspend'),payer); await runUntil(denied.id,'denied');
  const reasons=service.get(denied.id).evaluation.reasons.join('; ');
  report(`(c) $150 cumulative attempt denied: ${reasons}`, 'BLOCKED  $150.00 cumulative spending exceeds the $100 daily cap.', 'red');
  if (present) {
    console.log(`\nDaily budget remaining: $${service.limits().remaining_today}`);
    console.log('No funds sent for the blocked request.');
    console.log('\nHuman approval cannot override the hard limit.');
  }
  await pause(3200);
  scene('4 / 4  Retry without a second payment');
  if (present) console.log('Retry: the original $5.00 request, with the SAME idempotency key\n');
  const retry=await service.request(firstInput,payer); await service.tick(); assert.equal(retry.id,first.id);
  assert.equal(runtime.balance('ledger:test:treasury'),5000); assert.equal(runtime.balance('ledger:test:dataco'),5000);
  assert.equal((store.db.prepare('SELECT COUNT(*) n FROM rail_operations').get() as {n:number}).n,2); assert.equal(executor.prepared,0);
  report('(d) Retry returned the original ID; exactly two ledger debits, no chain transfers.', 'SAME PAYMENT  Original ID returned. No extra debit.');
  if (present) {
    console.log(`\nPayment ID  ${first.id}`);
    console.log('Ledger      $50.00 spent; exactly two debits ($5 + $45)');
    console.log('Network     No chain transfers and no real notifications\n');
    console.log('github.com/faizan896/invisiblehorses');
  }
  console.log('Offline demo passed. All assertions verified.');
} finally { store.close(); }
