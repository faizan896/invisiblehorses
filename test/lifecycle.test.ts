import { afterEach, describe, expect, it } from 'vitest';
import { RoutingRulesSchema } from '../src/policy/routing.js';
import { loadPolicy } from '../src/policy/loader.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { serve } from '@hono/node-server';
import { fixture, approvalToken, agentId, intent as oldIntent } from './support.js';
import { RailRuntime } from '../src/executor/rail-runtime.js';
import { UnifiedPaymentService } from '../src/executor/unified.js';
import { Counterparties } from '../src/counterparty/profiles.js';
import { QuoteService, defaultAdapters } from '../src/rails/quotes.js';
import { RoutingService } from '../src/router/service.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import { safeFallback, assertTransition } from '../src/executor/state.js';
import { MockTestnetExecutor } from '../examples/support/mock.js';
import type { RailExecution, RouteQuote } from '../src/rails/adapter.js';

const close: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of close.splice(0).reverse()) await c(); });
function setup() {
  const f = fixture(); close.push(() => f.store.close());
  let now = new Date('2026-10-27T14:00:00Z'); f.setNow(now.toISOString());
  const catalog = f.profiles.list(); const profiles = Counterparties.from(() => catalog);
  const returns = new MockTestnetExecutor();
  const runtime = new RailRuntime(f.store, profiles, agentId, { executor: f.executor, address: profiles.get(agentId).stablecoin_wallets[0]!.address, balanceMinor: async () => 10000, returnExecutor: returns, returnAddress: profiles.get('dataco').stablecoin_wallets[0]!.address }, () => now);
  const quotes = new QuoteService(profiles, defaultAdapters(undefined, undefined, runtime), () => now);
  const routing = new RoutingService(f.store, profiles, quotes, () => f.policy, () => now);
  const service = new UnifiedPaymentService(f.store, f.service, profiles, routing, runtime, () => f.policy, f.tokens, f.notifier, 'https://approvals.example.test', () => now);
  f.policy.new_merchant_max = '100';
  const app = createApp(service, f.config, quotes, routing);
  const setNow = (s: string) => { now = new Date(s); f.setNow(s); };
  return { ...f, legacy: f.service, profiles, catalog, runtime, returns, quotes, routing, service, app, setNow };
}
type F = ReturnType<typeof setup>;
function intent(amount = '5', key = 'lifecycle-1', delivery = 'any') {
  return { idempotency_key: key, payer: agentId, recipient: 'dataco', amount, destination_currency: 'USD', deadline: '2026-11-06T23:00:00Z', purpose: 'dataset access', max_fee: '5', reversibility_requirement: 'none', recipient_preferences: { delivery } };
}
async function ticks(f: F, n = 1) { for (let i = 0; i < n; i++) await f.service.tick(); }
function status(f: F, id: string) { return f.service.get(id).status; }
function rowCount(f: F, table: string) { return (f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n; }

 describe('unified execution lifecycle and durable accounting', () => {
  it('records every common lifecycle stage; retries never debit twice and returns are idempotent', async () => {
    const f = setup(), p = await f.service.request(intent(), agentId);
    expect(p.status).toBe('created');
    for (const expected of ['recipient_resolved','route_selected','funds_reserved','settled','completed']) { await ticks(f); expect(status(f, p.id)).toBe(expected); }
    expect(JSON.stringify(f.store.events())).toContain('payment_in_transit');
    expect(f.runtime.balance('ledger:test:treasury')).toBe(9500);
    expect(f.runtime.balance('ledger:test:dataco')).toBe(500);
    expect(await f.service.request(intent('5.00'), agentId)).toMatchObject({ id: p.id, status: 'completed' });
    await ticks(f, 2); expect(rowCount(f, 'rail_operations')).toBe(1); expect(rowCount(f, 'test_rail_journal')).toBe(1);
    expect(await f.service.reverse(p.id)).toMatchObject({ status: 'returned' });
    const op = f.store.db.prepare('SELECT id FROM rail_operations').get() as { id: string };
    await f.runtime.reverse('ledger', op.id); expect(f.runtime.balance('ledger:test:treasury')).toBe(10000);
    expect(rowCount(f, 'test_rail_journal')).toBe(2); expect(f.service.limits().spent_or_reserved_today).toBe('0.00');
    expect(() => f.store.db.prepare("UPDATE test_rail_journal SET amount_minor = 1").run()).toThrow('append-only');
  });
  it('rejects conflicting keys, payer forgery and arbitrary legacy destinations', async () => {
    const f = setup(); await f.service.request(intent(), agentId);
    await expect(f.service.request(intent('6'), agentId)).rejects.toThrow('different intent');
    await expect(f.service.request({ ...intent(), payer: 'attacker' }, agentId)).rejects.toThrow('Payer');
    await expect(f.service.request({ ...oldIntent(), recipient: { ...oldIntent().recipient, address: '0x0000000000000000000000000000000000000009' } }, agentId)).rejects.toThrow('catalog');
    await expect(f.service.request({ ...intent(), rail: 'ledger' }, agentId)).rejects.toThrow();
  });
  it('preserves already completed M1 fingerprints and never re-executes them', async () => {
    const f = setup(), original = oldIntent();
    const paid = await f.service.request(original, agentId); // New legacy calls use the full gates.
    await ticks(f, 7); expect(status(f, paid.id)).toBe('completed');
    const retries = await Promise.all(Array.from({ length: 10 }, () => f.service.request(original, agentId)));
    expect(new Set(retries.map((p) => p.id)).size).toBe(1); expect(f.executor.prepared).toBe(1);
    expect(f.executor.broadcasts.size).toBe(1);
  });
  it('keeps pre-existing M1 records readable and exactly idempotent after migration', async () => {
    const f = setup(), original = oldIntent();
    const old = await f.legacy.request(original, agentId); await f.legacy.tick(); await f.legacy.tick();
    const retry = await f.service.request(original, agentId);
    expect(retry).toMatchObject({ id: old.id, status: 'completed', transaction_hash: f.store.get(old.id)!.transaction_hash });
    await ticks(f,3); expect(f.executor.prepared).toBe(1); expect(rowCount(f,'payment_contexts')).toBe(0);
  });
  it('native return failure never reports returned or releases already spent principal', async () => {
    const f=setup(), p=await f.service.request(intent('5','failed-return','wallet'),agentId); await ticks(f,7);
    f.returns.reverted=true; await f.service.reverse(p.id); await ticks(f,3);
    expect(status(f,p.id)).toBe('failed'); expect(f.service.limits().spent_or_reserved_today).toBe('5.03');
    expect(f.returns.prepared).toBe(1); expect(JSON.stringify(f.service.get(p.id).evaluation)).toContain('not returned');
  });
  it('a missing cooperative signer fails clearly without changing a completed payment', async () => {
    const f=setup(), p=await f.service.request(intent('5','no-return-signer','wallet'),agentId); await ticks(f,7);
    f.runtime.native.returnExecutor=undefined;
    await expect(f.service.reverse(p.id)).rejects.toThrow('cooperation');
    expect(status(f,p.id)).toBe('completed'); expect(f.service.limits().spent_or_reserved_today).toBe('5.03');
  });
  it('a reverted forward transaction cannot refund unrelated recipient funds', async () => {
    const f=setup(); f.executor.reverted=true;
    const p=await f.service.request(intent('5','no-principal','wallet'),agentId); await ticks(f,7);
    await expect(f.service.reverse(p.id)).rejects.toThrow('No principal'); expect(f.returns.prepared).toBe(0);
  });
  it('serializes the signing wallet while a prior transaction has an unknown receipt', async () => {
    const f=setup(); f.executor.receipt=async()=> 'pending';
    const a=await f.service.request(intent('5','wallet-a','wallet'),agentId), b=await f.service.request(intent('5','wallet-b','wallet'),agentId);
    await ticks(f,8); expect(status(f,a.id)).toBe('in_transit'); expect(status(f,b.id)).toBe('funds_reserved'); expect(f.executor.prepared).toBe(1);
  });
  it('stale quotes cannot execute beyond the intent deadline', async () => {
    const f=setup(), p=await f.service.request({...intent(),deadline:'2026-10-27T14:01:00Z'},agentId); await ticks(f,3);
    f.setNow('2026-10-27T14:02:00Z'); await ticks(f,2); expect(status(f,p.id)).toBe('denied'); expect(rowCount(f,'rail_operations')).toBe(0);
  });
  it('rechecks daily allowance at execution across UTC rollover', async () => {
    const f=setup(); f.policy.require_approval_above='100';
    f.setNow('2026-10-27T23:59:00Z');
    const a=await f.service.request(intent('60','roll-a'),agentId); await ticks(f,3);
    f.setNow('2026-10-28T00:00:00Z');
    const b=await f.service.request(intent('60','roll-b'),agentId); await ticks(f,8);
    expect(status(f,a.id)).toBe('completed'); expect(status(f,b.id)).toBe('denied'); expect(f.service.limits().spent_or_reserved_today).toBe('60.00');
  });
  it('never lets parallel requests overspend the daily budget', async () => {
    const f = setup(); f.policy.require_approval_above = '100';
    const [a, b] = await Promise.all([f.service.request(intent('60','a'),agentId), f.service.request(intent('60','b'),agentId)]);
    await ticks(f, 7);
    expect([status(f,a.id),status(f,b.id)].sort()).toEqual(['completed','denied']);
    expect(f.runtime.balance('ledger:test:treasury')).toBe(4000);
  });
  it('releases source and budget holds on rejection and expiry; tokens cannot be replayed', async () => {
    const f = setup(), p = await f.service.request(intent('45'),agentId); await ticks(f,3);
    expect(status(f,p.id)).toBe('pending_approval'); expect(f.service.limits().remaining_today).toBe('55.00');
    const n = f.notifier.notifications[0]!;
    expect(f.service.decide(approvalToken(n.rejectUrl)).status).toBe('rejected');
    expect(() => f.service.decide(approvalToken(n.approveUrl))).toThrow('already');
    expect(f.service.limits().remaining_today).toBe('100.00');
    const p2 = await f.service.request(intent('45','expires'),agentId); await ticks(f,3);
    f.setNow('2026-10-27T14:16:00Z'); await ticks(f);
    expect(status(f,p2.id)).toBe('expired'); expect(f.service.limits().remaining_today).toBe('100.00');
    expect((f.store.db.prepare("SELECT COUNT(*) n FROM test_rail_holds WHERE state = 'active'").get() as {n:number}).n).toBe(0);
  });
  it('approval cannot override a changed hard policy or changed beneficiary', async () => {
    const f = setup(), p = await f.service.request(intent('45'),agentId); await ticks(f,3);
    f.policy.max_per_payment = '40'; f.service.decide(approvalToken(f.notifier.notifications[0]!.approveUrl)); await ticks(f);
    expect(status(f,p.id)).toBe('denied'); expect(rowCount(f,'rail_operations')).toBe(0);
    f.policy.max_per_payment = '100';
    const p2 = await f.service.request(intent('45','changed-profile'),agentId); await ticks(f,3);
    f.catalog.find((c) => c.id === 'dataco')!.internal_account = 'test:changed';
    f.service.decide(approvalToken(f.notifier.notifications[1]!.approveUrl)); await ticks(f);
    expect(status(f,p2.id)).toBe('denied'); expect(rowCount(f,'rail_operations')).toBe(0);
  });
  it('reprices expired approval quotes within the approved source cap', async () => {
    const f = setup(), p = await f.service.request(intent('45'),agentId); await ticks(f,3);
    f.setNow('2026-10-27T14:06:00Z'); f.service.decide(approvalToken(f.notifier.notifications[0]!.approveUrl)); await ticks(f,8);
    expect(status(f,p.id)).toBe('completed'); expect(rowCount(f,'approvals')).toBe(1);
    expect(rowCount(f,'route_plans')).toBe(2);
  });
  it('fails safely if new-quote cost exceeds the amount the human approved', async () => {
    const f = setup(), p = await f.service.request(intent('45'),agentId); await ticks(f,3);
    f.setNow('2026-10-27T14:06:00Z'); f.service.decide(approvalToken(f.notifier.notifications[0]!.approveUrl));
    f.runtime.failures.set('ledger','before-submit');
    await ticks(f,12); // Ledger attempt fails; all alternatives add fees and exceed approved $45.
    expect(status(f,p.id)).toBe('failed'); expect(f.executor.prepared).toBe(0); expect(f.runtime.balance('ledger:test:treasury')).toBe(10000);
  });
  it('falls back after a known pre-submit failure, with fresh gates and one debit', async () => {
    const f = setup(); f.runtime.failures.set('ledger','before-submit');
    const p = await f.service.request(intent(),agentId); await ticks(f,12);
    expect(status(f,p.id)).toBe('completed');
    expect(rowCount(f,'rail_operations')).toBe(2); expect(f.executor.prepared).toBe(1); expect(f.runtime.balance('ledger:test:treasury')).toBe(10000);
    expect(JSON.stringify(f.store.events())).toContain('safe_fallback');
  });
  it.each(['unknown-after-submit','fx-exposure'] as const)('does not fall back on %s', async (failure) => {
    const f = setup(); f.runtime.failures.set('ledger',failure);
    const p = await f.service.request(intent(),agentId); await ticks(f,12);
    expect(status(f,p.id)).toBe('failed'); expect(rowCount(f,'rail_operations')).toBe(1); expect(f.executor.prepared).toBe(0);
    expect(f.service.limits().spent_or_reserved_today).toBe('5.00');
  });
  it('a timeout after submission reconciles the same persisted bytes/hash across restart', async () => {
    const f = setup(); f.executor.ambiguousBroadcast = true;
    const p = await f.service.request(intent('5','native','wallet'),agentId); await ticks(f,4);
    expect(status(f,p.id)).toBe('in_transit'); expect(f.executor.prepared).toBe(1); expect(f.executor.broadcasts.size).toBe(1);
    const hash = f.store.get(p.id)!.transaction_hash; await f.service.initialize(); await ticks(f,3);
    expect(status(f,p.id)).toBe('completed'); expect(f.store.get(p.id)!.transaction_hash).toBe(hash); expect(f.executor.prepared).toBe(1);
  });
  it('quarantines interrupted signing instead of allocating another nonce', async () => {
    const f = setup(), p = await f.service.request(intent('5','crash','wallet'),agentId); await ticks(f,4);
    f.store.db.prepare("UPDATE rail_operations SET state = 'preparing', raw = NULL, hash = NULL").run();
    await f.service.initialize(); await ticks(f,4);
    expect(status(f,p.id)).toBe('failed'); expect(f.executor.prepared).toBe(1); expect(f.service.limits().spent_or_reserved_today).toBe('5.03');
  });
  it('a reverted native transaction retains the modeled gas charge without claiming a return', async () => {
    const f = setup(); f.executor.reverted = true;
    const p = await f.service.request(intent('5','revert','wallet'),agentId); await ticks(f,8);
    expect(status(f,p.id)).toBe('failed'); expect(f.service.limits().spent_or_reserved_today).toBe('0.02'); expect(f.executor.prepared).toBe(1);
  });
  it('cooperative native returns use a second real-executor interface and only mark returned after confirmation', async () => {
    const f = setup(), p = await f.service.request(intent('5','return-native','wallet'),agentId); await ticks(f,7);
    expect(status(f,p.id)).toBe('completed'); await f.service.reverse(p.id);
    expect(status(f,p.id)).not.toBe('returned'); expect(f.returns.prepared).toBe(1); await ticks(f,2);
    expect(status(f,p.id)).toBe('returned'); expect(f.service.limits().spent_or_reserved_today).toBe('0.03'); expect(f.returns.prepared).toBe(1);
    expect(f.returns.preparedIntents[0]).toMatchObject({ amount: '5.00', recipient: { address: f.runtime.native.address } });
    expect(f.executor.preparedIntents[0]!.recipient.address).toBe(f.profiles.get('dataco').stablecoin_wallets[0]!.address);
    expect([...f.returns.broadcasts][0]).not.toBe(f.store.get(p.id)!.transaction_hash);
  });
  it('a fresh wallet demo fits the example new-merchant cap including modeled fees', async () => {
    const f=setup(); Object.assign(f.policy,loadPolicy('policies/example.yaml'));
    const p=await f.service.request(intent('5','fresh-wallet','wallet'),agentId); await ticks(f,7);
    expect(status(f,p.id)).toBe('completed'); expect(f.service.limits().spent_or_reserved_today).toBe('5.03');
  });
  it('chain settlement cannot complete bank delivery, and cooperative return removes the modeled payout only after confirmation', async () => {
    const f=setup(); f.policy.routing=RoutingRulesSchema.parse({allowed_rails:['usdc-base-sepolia']});
    const p=await f.service.request(intent('5','chain-to-bank','bank'),agentId); await ticks(f,5);
    expect(status(f,p.id)).toBe('settled'); expect(f.runtime.balance('bank:TEST-US-DATACO')).toBe(0);
    await ticks(f,3); expect(status(f,p.id)).toBe('settled');
    const q=JSON.parse((f.store.db.prepare('SELECT quote FROM rail_operations').get() as {quote:string}).quote) as RouteQuote;
    f.setNow(q.expected_available_at); await ticks(f); expect(status(f,p.id)).toBe('completed'); expect(f.runtime.balance('bank:TEST-US-DATACO')).toBe(500);
    await f.service.reverse(p.id); expect(status(f,p.id)).toBe('settled'); expect(f.runtime.balance('bank:TEST-US-DATACO')).toBe(500);
    await ticks(f); expect(status(f,p.id)).toBe('returned'); expect(f.runtime.balance('bank:TEST-US-DATACO')).toBe(0);
    expect(f.returns.prepared).toBe(1);
  });
  it('bank settlement precedes usable funds; a closed destination returns principal and retains fees', async () => {
    const f = setup(), p = await f.service.request(intent('5','bank','bank'),agentId); await ticks(f,4);
    const q = JSON.parse((f.store.db.prepare('SELECT quote FROM rail_operations').get() as {quote:string}).quote) as RouteQuote;
    expect(q.rail).toBe('ach-mock');
    f.setNow(new Date(Date.parse(q.expected_available_at)-3600000).toISOString()); await ticks(f);
    expect(status(f,p.id)).toBe('settled');
    f.catalog.find((c) => c.id === 'dataco')!.bank_accounts[0]!.status = 'closed';
    f.setNow(q.expected_available_at); await ticks(f);
    expect(status(f,p.id)).toBe('returned'); expect(f.runtime.balance('bank:TEST-US-TREASURY')).toBe(9974);
    expect(f.store.get(p.id)!.spent_minor).toBe(26);
    expect(f.store.history('2026-10-27T23:00:00Z').spent_today).toBe('0.26');
  });
  it('only completes a normal bank payment once recipient bank funds are available', async () => {
    const f = setup(), p = await f.service.request(intent('5','normal-bank','bank'),agentId); await ticks(f,4);
    const q = JSON.parse((f.store.db.prepare('SELECT quote FROM rail_operations').get() as {quote:string}).quote) as RouteQuote;
    f.setNow(new Date(Date.parse(q.expected_available_at)-3600000).toISOString()); await ticks(f,2); expect(status(f,p.id)).toBe('settled');
    f.setNow(q.expected_available_at); await ticks(f); expect(status(f,p.id)).toBe('completed'); expect(f.runtime.balance('bank:TEST-US-DATACO')).toBe(500);
  });
  it('compliance denials happen before reservations or signing', async () => {
    const f = setup(); f.catalog.find((p) => p.id === 'dataco')!.kyb_status = 'rejected';
    const p = await f.service.request(intent(),agentId); await ticks(f,4);
    expect(status(f,p.id)).toBe('denied'); expect(rowCount(f,'test_rail_holds')).toBe(0); expect(f.executor.prepared).toBe(0);
  });
  it('rechecks policy after asynchronous native preparation, before persisting/submitting bytes', async () => {
    const f = setup(); const prepare = f.executor.prepare.bind(f.executor);
    f.executor.prepare = async (i) => { const signed = await prepare(i); f.policy.max_per_payment = '1'; return signed; };
    const p = await f.service.request(intent('5','late-policy','wallet'),agentId); await ticks(f,9);
    expect(['denied','failed']).toContain(status(f,p.id)); expect(f.executor.broadcasts.size).toBe(0);
  });
});

describe('fallback authorization and API boundaries', () => {
  it.each(['outflow','irreversible','fx','currency','amount','form','approval','fee'] as const)('blocks unsafe fallback: %s', async (kind) => {
    const f = setup(); const input = intent('5','fallback','bank'); const result = await f.quotes.quotes(input,agentId);
    const q = structuredClone(result.quotes.find((q) => q.rail === 'ach-mock')!);
    const out: RailExecution = { id:'failed',status:'failed',irreversible:false,recipient_usable:false,funds_may_have_left:false,fx_exposure:false,charged_fee_usd:'0' };
    let cap: number|null = null;
    if(kind==='outflow') out.funds_may_have_left = undefined;
    if(kind==='irreversible') out.irreversible = true;
    if(kind==='fx') out.fx_exposure = true;
    if(kind==='currency') q.recipient_amount.currency = 'MXN';
    if(kind==='amount') q.recipient_amount.amount = '4.99';
    if(kind==='form') q.destination_form = 'wallet';
    if(kind==='approval') cap = 500;
    if(kind==='fee') out.charged_fee_usd = '0.01';
    expect(safeFallback(result.intent,q,out,cap).safe).toBe(false);
    expect(() => assertTransition('completed','in_transit')).toThrow();
  });
  it('accepts the full intent through the official MCP client and keeps owner controls private', async () => {
    const f=setup(), http=serve({fetch:f.app.fetch,hostname:'127.0.0.1',port:0});
    await new Promise<void>((r)=>http.once('listening',r)); close.push(()=>new Promise<void>((r)=>http.close(()=>r())));
    const addr=http.address(); if(!addr || typeof addr==='string') throw new Error('No test port');
    const server=createMcpServer(`http://127.0.0.1:${addr.port}`,f.config.agentToken), client=new Client({name:'lifecycle-test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair(); await server.connect(a);await client.connect(b); close.push(()=>server.close());close.push(()=>client.close());
    const tools=await client.listTools(); expect(tools.tools).toHaveLength(7);
    expect(JSON.stringify(tools.tools.find((t)=>t.name==='request_payment')!.inputSchema)).toContain('destination_currency');
    const result=await client.callTool({name:'request_payment',arguments:intent()}); expect(result.isError).toBe(false);
    const p=JSON.parse((result.content as {text:string}[])[0]!.text) as {id:string}; await ticks(f,6);
    expect(status(f,p.id)).toBe('completed');
    expect(JSON.stringify(f.service.get(p.id))).not.toMatch(/signed_transaction|return_raw|operation_key|approveUrl/);
    const agent=await f.app.request(`/owner/payments/${p.id}/return`,{method:'POST',headers:{Authorization:`Bearer ${f.config.agentToken}`,'Content-Type':'application/json'},body:'{}'});expect(agent.status).toBe(401);
    const owner=await f.app.request(`/owner/payments/${p.id}/return`,{method:'POST',headers:{Authorization:`Bearer ${f.config.ownerToken}`,'Content-Type':'application/json'},body:'{}'});expect(owner.status).toBe(200);
    const page=await f.app.request('/dashboard',{headers:{Authorization:`Bearer ${f.config.ownerToken}`}}); expect(page.status).toBe(200); expect(await page.text()).toContain('DataCo');
  });
});
