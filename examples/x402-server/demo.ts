import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createFixture } from './server.js';
import { Store } from '../../src/audit/store.js';
import { loadPolicy } from '../../src/policy/loader.js';
import { ApprovalTokens } from '../../src/approval/tokens.js';
import { X402Service } from '../../src/x402/service.js';
import { ExactProtocol } from '../../src/x402/protocol.js';

console.log('x402 v2 demo: OFFICIAL SDK + middleware + EIP-712 signatures; MOCK chain settlement, no external calls.');
const fixture = createFixture(), store = new Store(':memory:'), account = privateKeyToAccount(generatePrivateKey());
const policy = { ...loadPolicy('policies/example.yaml'), x402: { max_per_request: '1.00', max_per_day: '10.00', allowed_hosts: [{ host: 'api.example.test', category: 'data' as const }], categories: ['data' as const] } };
const protocol = new ExactProtocol({ signer: account, assertTestnet: async () => {}, verifySettlement: async (r, q) => fixture.verifyReceipt(r, q) });
const api = new X402Service({ store, policy: () => policy, tokens: new ApprovalTokens('offline-demo-secret-placeholder-32'), notifier: { notify: async () => { throw new Error('Unexpected approval in demo'); } }, protocol, balanceMinor: async () => 10000, publicBaseUrl: 'https://owner.example.test', fetcher: async (url, init) => fixture.app.fetch(new Request(String(url), init)) });
try {
  await api.initialize();
  const request = { url: 'https://api.example.test/weather', max_price: '1.00', purpose: 'weather lookup', idempotency_key: 'weather-once' };
  const first = await api.request(request, 'demo-agent'); assert.equal(first.status, 'completed');
  console.log('1. $0.01 test USDC paid →', first.resource!.body);
  const denied = await api.request({ ...request, url: 'https://api.example.test/expensive', idempotency_key: 'over-cap' }, 'demo-agent');
  assert.equal(denied.status, 'denied'); console.log('2. $5.00 denied →', denied.evaluation.reasons.join('; '));
  assert.deepEqual(await api.request(request, 'demo-agent'), first); assert.equal(fixture.charges(), 1);
  console.log('3. Same request retried → cached resource + receipt. Total payments: 1.');
} finally { store.close(); }
