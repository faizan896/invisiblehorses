import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createGateway } from '../src/http/gateway.js';
import handler from '../api/index.js';
import { createApp } from '../src/http/app.js';
import { fixture, intent, approvalToken, agentId } from './support.js';

const origin = 'https://railgate-test.onrender.com';
const closed: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of closed.splice(0).reverse()) await c(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('Vercel gateway', () => {
  it('preserves payment JSON, the idempotency key and only necessary authentication headers', async () => {
    let target: Request | undefined;
    const fetcher: typeof fetch = async (input, init) => { target = new Request(input, init); return Response.json({ status: 'created' }, { status: 202 }); };
    const gateway = createGateway(origin, fetcher);
    const data = JSON.stringify({ idempotency_key: 'retry-this-key', payer: agentId, amount: '5' });
    const response = await gateway(new Request('https://railgate.vercel.app/api/payments', { method: 'POST', headers: { Authorization: 'Bearer limited-agent', 'Content-Type': 'application/json', Cookie: 'do-not-forward', 'X-Forwarded-Host': 'attacker.example' }, body: data }));
    expect(response.status).toBe(202); expect(target!.url).toBe(origin + '/api/payments');
    expect(await target!.text()).toBe(data); expect(target!.headers.get('Authorization')).toBe('Bearer limited-agent');
    expect(target!.headers.has('cookie')).toBe(false); expect(target!.headers.has('x-forwarded-host')).toBe(false);
  });
  it('keeps approval signatures intact and preserves POST semantics', async () => {
    let actual: Request | undefined;
    const gateway = createGateway(origin, async (url, init) => { actual = new Request(url, init); return new Response('Approval recorded'); });
    await gateway(new Request('https://railgate.vercel.app/approval-actions?token=abc_DEF.xyz-123', { method: 'POST' }));
    expect(actual!.url).toBe(origin + '/approval-actions?token=abc_DEF.xyz-123'); expect(actual!.method).toBe('POST');
  });
  it('retains owner protection and security headers', async () => {
    const gateway = createGateway(origin, async () => new Response('Owner authentication required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="railgate owner"', 'Content-Security-Policy': "default-src 'none'", 'Set-Cookie': 'not-forwarded' } }));
    const r = await gateway(new Request('https://railgate.vercel.app/dashboard'));
    expect(r.status).toBe(401); expect(r.headers.get('WWW-Authenticate')).toContain('Basic'); expect(r.headers.get('Content-Security-Policy')).toContain("default-src 'none'"); expect(r.headers.has('set-cookie')).toBe(false);
  });
  it.each([undefined, 'http://localhost:3000', 'https://attacker.example', 'https://user:pass@backend.onrender.com', 'https://backend.onrender.com/?secret=1'])('fails closed with an invalid backend: %s', async (backend) => {
    let calls=0; const gateway=createGateway(backend,async()=>{calls++;return new Response();});
    expect((await gateway(new Request('https://railgate.vercel.app/dashboard'))).status).toBe(503); expect(calls).toBe(0);
  });
  it('rejects unknown paths, excessive bodies and unsupported methods before forwarding', async () => {
    let calls=0; const gateway=createGateway(origin,async()=>{calls++;return new Response();});
    expect((await gateway(new Request('https://railgate.vercel.app/.env'))).status).toBe(404);
    expect((await gateway(new Request('https://railgate.vercel.app/api/payments',{method:'DELETE'}))).status).toBe(405);
    expect((await gateway(new Request('https://railgate.vercel.app/api/payments',{method:'POST',body:'x'.repeat(16385)}))).status).toBe(413);expect(calls).toBe(0);
  });
  it('never follows an upstream redirect to another host', async () => {
    let mode: RequestRedirect | undefined;
    const gateway=createGateway(origin,async(_,init)=>{mode=init?.redirect;return new Response(null,{status:302,headers:{Location:'https://attacker.example'}});});
    expect((await gateway(new Request('https://railgate.vercel.app/api/limits',{headers:{Authorization:'Bearer agent'}}))).status).toBe(503);expect(mode).toBe('manual');
  });
  it('returns a safe retry instruction after an ambiguous upstream timeout', async () => {
    const gateway=createGateway(origin,async()=>{throw new Error('Internal details should not be exposed');});
    const r=await gateway(new Request('https://railgate.vercel.app/api/payments',{method:'POST',body:'{}'}));expect(r.status).toBe(503);expect(await r.text()).toContain('SAME idempotency key');
  });
  it('serves the actual Node function on HTTP and directs the root to the dashboard', async () => {
    const server=createServer((req,res)=>{void handler(req,res);});await new Promise<void>((r)=>server.listen(0,'127.0.0.1',r));closed.push(()=>new Promise<void>((r)=>server.close(()=>r())));
    const addr=server.address();if(!addr||typeof addr==='string')throw new Error('No port');
    const r=await fetch(`http://127.0.0.1:${addr.port}/`,{redirect:'manual'});expect(r.status).toBe(302);expect(r.headers.get('location')).toBe('/dashboard');
  });
  it.each([false,true])('the Node function forwards payment JSON with Vercel body parsing=%s', async (parsed) => {
    const nativeFetch=globalThis.fetch;
    let forwarded: Request | undefined;
    vi.stubEnv('RAILGATE_BACKEND_ORIGIN',origin);
    vi.stubGlobal('fetch',async (input: RequestInfo | URL,init?: RequestInit)=>{forwarded=new Request(input,init);return Response.json({id:'same-payment',status:'created'},{status:202});});
    const server=createServer((req,res)=>{void (async()=>{
      if(parsed){const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));Object.assign(req,{body:JSON.parse(Buffer.concat(chunks).toString())});}
      await handler(req,res);
    })();});
    await new Promise<void>((r)=>server.listen(0,'127.0.0.1',r));closed.push(()=>new Promise<void>((r)=>server.close(()=>r())));
    const addr=server.address();if(!addr||typeof addr==='string')throw new Error('No port');
    const payload={idempotency_key:'keep-this-key',payer:agentId,amount:'5'};
    const r=await nativeFetch(`http://127.0.0.1:${addr.port}/api/payments`,{method:'POST',headers:{Authorization:'Bearer restricted-agent','Content-Type':'application/json'},body:JSON.stringify(payload)});
    expect(r.status).toBe(202);expect(await r.json()).toMatchObject({id:'same-payment'});
    expect(forwarded!.url).toBe(origin+'/api/payments');expect(await forwarded!.json()).toEqual(payload);expect(forwarded!.headers.get('authorization')).toBe('Bearer restricted-agent');
  });
});
describe('read-only migration mode', () => {
  it('preserves historical reads while refusing requests and approval consumption', async () => {
    const f=fixture();closed.push(()=>f.store.close());f.policy.new_merchant_max='100';
    const p=await f.service.request(intent('45'),agentId);const token=approvalToken(f.notifier.notifications[0]!.approveUrl);
    const app=createApp(f.service,{...f.config,readOnly:true},f.quotes,f.routing);
    const headers={Authorization:'Bearer '+f.config.agentToken,'Content-Type':'application/json'};
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/health')).headers.get('cache-control')).toBe('no-store');
    expect((await app.request('/api/payments/'+p.id,{headers})).status).toBe(200);
    expect((await app.request('/api/payments',{method:'POST',headers,body:JSON.stringify(intent('5','new'))})).status).toBe(503);
    expect((await app.request('/approval-actions?token='+token,{method:'POST'})).status).toBe(503);
    expect(f.store.list()).toHaveLength(1);expect(f.store.approval(p.id)!.state).toBe('pending');expect(f.executor.prepared).toBe(0);
  });
});
