import { afterEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { fixture, intent, agentId, complete } from './support.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const setup = () => { const f = fixture(); cleanups.push(() => f.store.close()); return f; };
describe('HTTP separation of agent and owner capabilities', () => {
  it('provides authenticated quote estimates without reserving or moving payment funds', async () => {
    const f = setup();
    const input = { idempotency_key: 'quote-only-1', payer: agentId, recipient: 'dataco', amount: '10', destination_currency: 'USD', deadline: '2026-11-06T23:00:00Z', purpose: 'test quote', max_fee: '10', reversibility_requirement: 'none', recipient_preferences: {} };
    expect((await f.app.request('/api/quotes', { method: 'POST', body: JSON.stringify(input) })).status).toBe(401);
    const response = await f.app.request('/api/quotes', { method: 'POST', headers: { Authorization: `Bearer ${f.config.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    const result = await response.json() as { quotes: unknown[]; execution_enabled: boolean };
    expect(result.quotes).toHaveLength(4); expect(result.execution_enabled).toBe(false);
    expect(f.store.list()).toHaveLength(0); expect(f.service.limits().remaining_today).toBe('100.00');
    expect(JSON.stringify(f.store.events())).toContain('quotes_requested');
  });
  it('requires separate owner authentication and never exposes signed tokens in agent responses', async () => {
    const f = setup(); f.policy.new_merchant_max = '100';
    for (const path of ['/approvals', '/dashboard', '/owner/audit']) {
      expect((await f.app.request(path)).status).toBe(401);
      expect((await f.app.request(path, { headers: { Authorization: `Bearer ${f.config.agentToken}` } })).status).toBe(401);
    }
    expect((await f.app.request('/api/limits')).status).toBe(401);
    expect((await f.app.request('/api/limits', { headers: { Authorization: `Bearer ${f.config.ownerToken}` } })).status).toBe(401);
    const headers = { Authorization: `Bearer ${f.config.agentToken}`, 'Content-Type': 'application/json' };
    const response = await f.app.request('/api/payments', { method: 'POST', headers, body: JSON.stringify(intent('45')) });
    expect(response.status).toBe(202);
    const data = await response.text();
    expect(data).toContain('pending_approval');
    for (const field of ['token=', 'nonce', 'signed_transaction', f.config.ownerToken]) expect(data).not.toContain(field);
    expect((await f.app.request('/approvals', { headers: { Authorization: `Basic ${Buffer.from(`owner:${f.config.ownerToken}`).toString('base64')}` } })).status).toBe(200);
  });
  it('only POST consumes an approval; reject and replay fail safely', async () => {
    const f = setup(); f.policy.new_merchant_max = '100';
    const p = await f.service.request(intent('45'), agentId);
    const notification = f.notifier.notifications[0]!;
    const path = new URL(notification.rejectUrl).pathname + new URL(notification.rejectUrl).search;
    expect((await f.app.request(path)).status).toBe(405);
    expect(f.service.get(p.id).status).toBe('pending_approval');
    expect((await f.app.request(path, { method: 'POST' })).status).toBe(200);
    expect((await f.app.request(path, { method: 'POST' })).status).toBe(409);
    await complete(f); expect(f.executor.prepared).toBe(0);
  });
  it('validates inputs, payer, pagination and idempotency conflict at the API boundary', async () => {
    const f = setup(); const headers = { Authorization: `Bearer ${f.config.agentToken}`, 'Content-Type': 'application/json' };
    const post = (body: unknown) => f.app.request('/api/payments', { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ ...intent(), amount: 5 })).status).toBe(400);
    expect((await post({ ...intent(), rail: 'skip-policy' })).status).toBe(400);
    expect((await post({ ...intent(), payer: 'forged-agent' })).status).toBe(403);
    expect((await post(intent())).status).toBe(202);
    expect((await post(intent('4'))).status).toBe(409);
    expect((await f.app.request('/api/payments?limit=-1', { headers })).status).toBe(400);
    expect((await f.app.request('/api/payments/not-a-uuid', { headers })).status).toBe(400);
    expect((await f.app.request('/api/payments', { method: 'POST', headers, body: 'a'.repeat(17000) })).status).toBe(413);
  });
  it('escapes agent content on owner pages and supplies security headers', async () => {
    const f = setup(); const input = intent(); input.purpose = '<script>alert(1)</script>';
    await f.service.request(input, agentId);
    const response = await f.app.request('/dashboard', { headers: { Authorization: `Bearer ${f.config.ownerToken}` } });
    const html = await response.text(); expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});
describe('official MCP client → MCP server → real HTTP API → SQLite integration', () => {
  it('runs the actual CLI over stdio using only the restricted agent environment', async () => {
    const f = setup();
    const http = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => http.once('listening', resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())));
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', 'mcp'],
      cwd: process.cwd(), stderr: 'pipe',
      env: { RAILGATE_API_URL: `http://127.0.0.1:${address.port}`, RAILGATE_AGENT_TOKEN: f.config.agentToken },
    });
    const client = new Client({ name: 'stdio-integration-test', version: '1.0.0' });
    cleanups.push(() => client.close());
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(6);
    const result = await client.callTool({ name: 'request_payment', arguments: intent() });
    expect(result.isError).toBe(false); await complete(f);
    expect(f.store.list()[0]!.status).toBe('completed');
  });
  it('discovers payment tools plus read-only quoting/planning and enforces policy/idempotency end to end', async () => {
    const f = setup();
    const http = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => http.once('listening', resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())));
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const server = createMcpServer(`http://127.0.0.1:${address.port}`, f.config.agentToken);
    const client = new Client({ name: 'railgate-integration-test', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    cleanups.push(() => client.close()); cleanups.push(() => server.close());
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['get_my_limits','get_payment_status','list_payments','plan_payment','quote_payment','request_payment']);
    const result = await client.callTool({ name: 'request_payment', arguments: intent() });
    expect(result.isError).toBe(false);
    const content = result.content as { type: string; text: string }[];
    const p = JSON.parse(content[0]!.text) as { id: string };
    await complete(f);
    const status = await client.callTool({ name: 'get_payment_status', arguments: { payment_id: p.id } });
    expect(JSON.stringify(status)).toContain('completed');
    await client.callTool({ name: 'request_payment', arguments: intent() }); await complete(f);
    expect(f.executor.prepared).toBe(1);
    expect(JSON.stringify(await client.callTool({ name: 'get_my_limits', arguments: {} }))).toContain('95.00');
    expect(JSON.stringify(await client.callTool({ name: 'list_payments', arguments: { limit: 5 } }))).toContain(p.id);
    const quote = await client.callTool({ name: 'quote_payment', arguments: { idempotency_key: 'quote-only-mcp', payer: agentId, recipient: 'norte', amount: '250000', destination_currency: 'MXN', deadline: '2026-11-06T23:00:00Z', purpose: 'invoice', max_fee: '1000', reversibility_requirement: 'none', recipient_preferences: { delivery: 'bank' } } });
    expect(quote.isError).toBe(false); expect(JSON.stringify(quote)).toContain('Norte Manufacturing');
    const plan = await client.callTool({ name: 'plan_payment', arguments: { idempotency_key: 'plan-only-mcp', payer: agentId, recipient: 'dataco', amount: '1', destination_currency: 'USD', deadline: '2026-11-06T23:00:00Z', purpose: 'plan', max_fee: '10', reversibility_requirement: 'none', recipient_preferences: {} } });
    expect(plan.isError).toBe(false); expect(JSON.stringify(plan)).toContain('Route chosen: ledger');
    expect(f.store.list()).toHaveLength(1); expect(f.executor.prepared).toBe(1);
    const bad = await client.callTool({ name: 'request_payment', arguments: { ...intent(), payer: 'impostor' } }); expect(bad.isError).toBe(true);
  });
});
