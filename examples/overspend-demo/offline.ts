import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../../src/audit/store.js';
import { loadPolicy } from '../../src/policy/loader.js';
import { PaymentService } from '../../src/executor/service.js';
import { ApprovalTokens } from '../../src/approval/tokens.js';
import { PaymentIntentSchema } from '../../src/intent/schema.js';
import { MockTestnetExecutor, RecordingNotifier } from '../support/mock.js';

console.log('OFFLINE DEMO: chain transfers and ntfy notifications are explicitly MOCKED.');
const store = new Store(':memory:'); const executor = new MockTestnetExecutor(); const notifier = new RecordingNotifier();
const service = new PaymentService(store, () => loadPolicy('policies/example.yaml'), new ApprovalTokens(randomBytes(32).toString('hex')), notifier, executor, 'https://offline.example.test');
const input = (amount: string, key: string) => PaymentIntentSchema.parse({ payer: 'research-agent-07', idempotency_key: key, amount, recipient: { id: 'dataco', name: 'DataCo', category: 'data', address: '0x0000000000000000000000000000000000000001' }, purpose: 'dataset access' });
try {
  await service.initialize();
  const first = await service.request(input('5', 'demo-allowed'), 'research-agent-07');
  await service.tick(); await service.tick(); assert.equal(service.get(first.id).status, 'completed');
  console.log('(a) $5 allowed and completed [MOCK transfer]');
  const second = await service.request(input('45', 'demo-approval'), 'research-agent-07');
  assert.equal(second.status, 'pending_approval');
  console.log('(b) $45 needs human approval [MOCK push; offline harness acts as owner]');
  service.decide(new URL(notifier.notifications[0]!.approveUrl).searchParams.get('token')!);
  await service.tick(); await service.tick(); assert.equal(service.get(second.id).status, 'completed');
  const denied = await service.request(input('100', 'demo-overspend'), 'research-agent-07');
  assert.equal(denied.status, 'denied'); console.log('(c) $150 cumulative attempt denied:', denied.evaluation.reasons.join('; '));
  const retry = await service.request(input('5', 'demo-allowed'), 'research-agent-07');
  await service.tick(); assert.equal(retry.id, first.id); assert.equal(executor.prepared, 2);
  console.log('(d) Same idempotency key returned the original payment; exactly 2 mock transfers total.');
  console.log('Offline demo passed. This does not validate real testnet execution or phone delivery.');
} finally { store.close(); }
