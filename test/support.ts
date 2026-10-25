import { Store } from '../src/audit/store.js';
import { ApprovalTokens } from '../src/approval/tokens.js';
import { PaymentService } from '../src/executor/service.js';
import { PolicySchema } from '../src/policy/schema.js';
import { PaymentIntentSchema } from '../src/intent/schema.js';
import { createApp } from '../src/http/app.js';
import { MockTestnetExecutor, RecordingNotifier } from '../examples/support/mock.js';
import { QuoteService } from '../src/rails/quotes.js';
import { Counterparties } from '../src/counterparty/profiles.js';

export const agentId = 'research-agent-07';
export function intent(amount = '5', key = 'invoice-1') {
  return PaymentIntentSchema.parse({ idempotency_key: key, payer: agentId, recipient: { id: 'dataco', name: 'DataCo', address: '0x0000000000000000000000000000000000000001', category: 'data' }, amount, purpose: 'dataset access' });
}
export function fixture(path = ':memory:') {
  const store = new Store(path);
  const executor = new MockTestnetExecutor(); const notifier = new RecordingNotifier();
  let now = new Date('2026-10-25T12:00:00Z');
  const policy = PolicySchema.parse({ max_per_payment: 100, max_per_day: 100, new_merchant_max: 5, require_approval_above: 20, expires_at: '2030-01-01T00:00:00Z', allowed_merchants: [{ id: 'dataco', categories: ['data'] }] });
  // These are synthetic test-only signing/auth strings, not credentials to any service.
  const tokens = new ApprovalTokens('test-only-signing-material-not-a-real-secret');
  const service = new PaymentService(store, () => policy, tokens, notifier, executor, 'https://approvals.example.test', () => now);
  const config = { ownerToken: 'test-only-owner-token-not-a-credential', agentToken: 'test-only-agent-token-not-a-credential', agentId };
  const quotes = new QuoteService(Counterparties.load('examples/counterparties.json'), undefined, () => now);
  const app = createApp(service, config, quotes);
  return { store, executor, notifier, service, policy, tokens, app, config, setNow: (value: string) => { now = new Date(value); } };
}
export function approvalToken(url: string) { return new URL(url).searchParams.get('token')!; }
export async function complete(f: ReturnType<typeof fixture>) { await f.service.tick(); await f.service.tick(); }
