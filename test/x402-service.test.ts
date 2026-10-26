import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { Store } from '../src/audit/store.js';
import { ApprovalTokens } from '../src/approval/tokens.js';
import type { ApprovalNotification } from '../src/approval/notifier.js';
import { loadPolicy } from '../src/policy/loader.js';
import { ExactProtocol } from '../src/x402/protocol.js';
import { X402Service } from '../src/x402/service.js';
import { createFixture } from '../examples/x402-server/server.js';
import { createApp } from '../src/http/app.js';
import { PaymentService } from '../src/executor/service.js';
import { MockTestnetExecutor } from '../examples/support/mock.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { vi } from 'vitest';
import { decodePaymentResponseHeader, encodePaymentResponseHeader } from '@x402/core/http';

const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { stores.forEach(s => s.close()); stores.length = 0; dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0; });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'railgate-x402-')); dirs.push(dir);
  const path = join(dir, 'state.sqlite');
  const fixture = createFixture(), account = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
  let now = new Date('2026-10-26T12:00:00Z'), signed = 0, paidCalls = 0, drop = false, flushFails = false;
  let rewrite: ((r: Response, paid: boolean) => Response) | undefined;
  const policy = { ...loadPolicy('policies/example.yaml'), x402: { max_per_request: '1.00', max_per_day: '10.00', allowed_hosts: [{ host: 'api.example.test', category: 'data' as const }], categories: ['data' as const] } };
  const notifications: ApprovalNotification[] = [];
  const protocol = new ExactProtocol({ signer: { address: account.address, signTypedData: args => { signed++; return account.signTypedData(args); } }, assertTestnet: async () => {}, verifySettlement: async (r, q) => fixture.verifyReceipt(r, q) });
  const open = () => { const s = new Store(path); stores.push(s); return s; };
  const service = (store: Store) => new X402Service({ store, policy: () => policy, tokens: new ApprovalTokens('s'.repeat(32)), notifier: { notify: async n => { notifications.push(n); } }, protocol, balanceMinor: async () => 10000, publicBaseUrl: 'https://owner.example.test', clock: () => now,
    beforeSend: async () => { if (flushFails) throw new Error('storage sync failed'); },
    fetcher: async (input, init) => { const paid = new Headers(init?.headers).has('PAYMENT-SIGNATURE'); if (paid) paidCalls++; const r = await fixture.app.fetch(new Request(String(input), init)); if (paid && drop) { drop = false; throw new Error('connection lost after settlement'); } return rewrite?.(r, paid) ?? r; },
  });
  const store = open(), api = service(store);
  return { store, api, fixture, policy, notifications, protocol, open, service, source: `chain:84532:${account.address.toLowerCase()}:USDC`, signed: () => signed, paidCalls: () => paidCalls, setDrop: () => { drop = true; }, setRewrite: (fn: typeof rewrite) => { rewrite = fn; }, setFlush: (v: boolean) => { flushFails = v; }, advance: () => { now = new Date(now.getTime() + 16 * 60000); } };
}
const request = { url: 'https://api.example.test/weather', max_price: '1.00', purpose: 'weather lookup', idempotency_key: 'weather-1' };
describe('durable x402 paid resources', () => {
  it('returns the official protected resource + independently checked receipt and caches identical retries', async () => {
    const h = setup(); await h.api.initialize();
    const first = await h.api.request(request, 'agent');
    expect(first).toMatchObject({ status: 'completed', resource: { status: 200 }, receipt: { success: true, network: 'eip155:84532' } });
    expect(JSON.parse(first.resource!.body)).toMatchObject({ weather: 'sunny', settlement: 'MOCK — no chain transaction' });
    expect(await h.api.request(request, 'agent')).toEqual(first);
    expect(h.signed()).toBe(1); expect(h.fixture.charges()).toBe(1);
    expect(JSON.stringify([first, h.store.events()])).not.toMatch(/PAYMENT-SIGNATURE|"signature"|"nonce"/);
    await expect(h.api.request({ ...request, purpose: 'changed' }, 'agent')).rejects.toThrow(/Idempotency/);
    await expect(h.api.get(first.id, 'other')).rejects.toThrow(/not found/);
  });
  it('denies server $5, unknown hosts and caller price spoofing before signing', async () => {
    const h = setup();
    expect(await h.api.request({ ...request, url: 'https://api.example.test/expensive' }, 'agent')).toMatchObject({ status: 'denied', evaluation: { reasons: expect.arrayContaining([expect.stringMatching(/per-request/)]) } });
    await expect(h.api.request({ ...request, url: 'https://other.example.test/weather' }, 'agent')).rejects.toThrow(/host/);
    await expect(h.api.request({ ...request, price: '0.00' }, 'agent')).rejects.toThrow();
    expect(h.signed()).toBe(0); expect(h.fixture.charges()).toBe(0);
  });
  it('atomically shares daily API reservations and the native wallet holds', async () => {
    const h = setup(); h.policy.x402.max_per_day = '0.01';
    const result = await Promise.all([h.api.request(request, 'agent'), h.api.request({ ...request, idempotency_key: 'other' }, 'agent')]);
    expect(result.map(r => r.status).sort()).toEqual(['completed', 'denied']); expect(h.fixture.charges()).toBe(1);
    h.policy.x402.max_per_day = '10.00';
    h.store.db.prepare("INSERT INTO test_rail_holds VALUES('native',?,10000,'active')").run(h.source);
    expect(await h.api.request({ ...request, idempotency_key: 'wallet-busy' }, 'agent')).toMatchObject({ status: 'denied' });
    expect(h.fixture.charges()).toBe(1);
  });
  it('requires the owner, rejects expired approvals, and never routes approved APIs through an ERC20 transfer', async () => {
    const h = setup(); h.policy.require_approval_above = '0.00';
    const pending = await h.api.request(request, 'agent'); expect(pending.status).toBe('pending_approval'); expect(h.signed()).toBe(0);
    const token = new URL(h.notifications[0]!.approveUrl).searchParams.get('token')!;
    expect(h.api.decideIfOwned(token)).toMatchObject({ status: 'funds_reserved' });
    await h.api.tick(); expect((await h.api.get(pending.id, 'agent')).status).toBe('completed');
    await expect(Promise.resolve().then(() => h.api.decideIfOwned(token))).rejects.toThrow(/pending/);
    const next = await h.api.request({ ...request, idempotency_key: 'expires' }, 'agent'); h.advance(); await h.api.tick();
    expect((await h.api.get(next.id, 'agent')).status).toBe('expired');
    expect(h.store.db.prepare('SELECT state FROM test_rail_holds WHERE payment_id=?').get(next.id)).toEqual({ state: 'released' });
    expect(h.fixture.charges()).toBe(1);
  });
  it('survives a lost response and restart using the same persisted authorization, charging only once', async () => {
    const h = setup(); h.setDrop(); const first = await h.api.request(request, 'agent'); expect(first.status).toBe('uncertain');
    h.store.close(); stores.splice(stores.indexOf(h.store), 1);
    const resumed = h.service(h.open()); await resumed.initialize();
    expect((await resumed.request(request, 'agent')).status).toBe('completed');
    expect(h.signed()).toBe(1); expect(h.fixture.charges()).toBe(1); expect(h.paidCalls()).toBe(2);
  });
  it('persists before sending, and retries a failed disk flush without creating a new signature', async () => {
    const h = setup(); h.setFlush(true);
    expect((await h.api.request(request, 'agent')).status).toBe('uncertain'); expect(h.paidCalls()).toBe(0);
    h.setFlush(false); expect((await h.api.request(request, 'agent')).status).toBe('completed');
    expect(h.signed()).toBe(1); expect(h.fixture.charges()).toBe(1);
  });
  it('rejects redirects before payment and keeps an invalid receipt reserved after delivery', async () => {
    const h = setup(); h.setRewrite(() => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }));
    expect((await h.api.request(request, 'agent')).status).toBe('failed'); expect(h.signed()).toBe(0);
    h.setRewrite((r, paid) => {
      if (!paid) return r;
      const receipt = decodePaymentResponseHeader(r.headers.get('PAYMENT-RESPONSE')!);
      const headers = new Headers(r.headers); headers.set('PAYMENT-RESPONSE', encodePaymentResponseHeader({ ...receipt, payer: '0x0000000000000000000000000000000000000009' }));
      return new Response(r.body, { status: r.status, headers });
    });
    const p = await h.api.request({ ...request, idempotency_key: 'forged-receipt' }, 'agent'); expect(p.status).toBe('uncertain'); expect(p.resource).toBeUndefined();
    expect(h.store.get(p.id)?.funds_locked).toBe(1); expect(h.fixture.charges()).toBe(1);
  });
  it('quarantines interrupted signing and never allocates a replacement authorization', async () => {
    const h = setup(); h.policy.require_approval_above = '0.00';
    const p = await h.api.request(request, 'agent');
    h.store.db.prepare("UPDATE resource_requests SET state='preparing' WHERE id=?").run(p.id);
    await h.api.initialize();
    expect((await h.api.request(request, 'agent')).status).toBe('uncertain'); expect(h.signed()).toBe(0); expect(h.paidCalls()).toBe(0);
  });
  it('connects the actual MCP tool to the authenticated HTTP boundary and owner approval dispatch', async () => {
    const h = setup(); h.policy.require_approval_above = '0.00';
    const executor = new MockTestnetExecutor();
    const legacy = new PaymentService(h.store, () => h.policy, new ApprovalTokens('s'.repeat(32)), { notify: async () => {} }, executor, 'https://owner.example.test', () => new Date('2026-10-26T12:00:00Z'));
    const app = createApp(legacy, { agentId: 'agent', agentToken: 'agent-token', ownerToken: 'owner-token' }, undefined, undefined, h.api);
    expect((await app.request('/api/paid-resources', { method: 'POST', body: JSON.stringify(request) })).status).toBe(401);
    const server = createMcpServer('https://railgate.example.test', 'agent-token'), client = new Client({ name: 'x402-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => app.fetch(new Request(String(input), init)));
    try {
      await server.connect(a); await client.connect(b);
      const tools = await client.listTools(); expect(tools.tools.map(t => t.name)).toContain('fetch_paid_resource');
      const result = await client.callTool({ name: 'fetch_paid_resource', arguments: request }); expect(result.isError).toBe(false);
      const n = h.notifications[0]!; const action = new URL(n.approveUrl);
      expect((await app.request(action.pathname + action.search, { method: 'POST' })).status).toBe(200);
      await legacy.tick(); expect(executor.prepared).toBe(0);
      await h.api.tick();
      const done = await client.callTool({ name: 'fetch_paid_resource', arguments: request }); expect(JSON.stringify(done)).toContain('completed'); expect(h.fixture.charges()).toBe(1);
    } finally { spy.mockRestore(); await client.close(); await server.close(); }
  });
});
