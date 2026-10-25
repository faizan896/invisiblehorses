import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { privateKeyToAccount } from 'viem/accounts';
import { exportHistory } from '../src/hosting/history-export.js';
import { fingerprint } from '../src/intent/fingerprint.js';
import { loadPolicy } from '../src/policy/loader.js';
import { fixture, intent, complete, agentId } from '../test/support.js';

const key=`0x${'0'.repeat(63)}1` as const;
const owner='test-only-owner-key-not-a-real-credential';
const agent='test-only-agent-key-not-a-real-credential';
let history: ReturnType<typeof exportHistory>, original: ReturnType<typeof intent>, originalId:string, originalHash:string;
const cleanups:(()=>Promise<void>|void)[]=[];
beforeAll(async()=>{
  const f=fixture();original=intent('5','before-hosting');const p=await f.service.request(original,agentId);await complete(f);originalId=p.id;originalHash=f.store.get(p.id)!.transaction_hash!;
  history=exportHistory(f.store.db,privateKeyToAccount(key).address,agentId);f.store.close();
});
afterEach(async()=>{for(const c of cleanups.splice(0).reverse())await c();});
async function setup(overrides: {policy?: unknown;now?:string} = {}){
  const dir=mkdtempSync(join(tmpdir(),'railgate-do-test-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const root=resolve('worker-dist/test');
  const modules=readdirSync(root).filter(f=>f.endsWith('.js')||f.endsWith('.yaml')).map(f=>({type:f.endsWith('.yaml')?'Text' as const:'ESModule' as const,path:join(root,f),contents:readFileSync(join(root,f),'utf8')}));
  modules.sort((a,b)=>a.type==='ESModule'?-1:b.type==='ESModule'?1:0);
  const mf=new Miniflare({name:'railgate-test',modules,modulesRoot:root,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{OWNER:{className:'TestRailgateOwner',useSQLite:true}},durableObjectsPersist:dir,
    bindings:{RAILGATE_PRIVATE_KEY:key,APPROVAL_SECRET:'test-only-signing-key-not-a-real-secret',OWNER_API_TOKEN:owner,AGENT_API_TOKEN:agent,PUBLIC_BASE_URL:'https://railgate.example.test',NTFY_TOPIC:'test-topic-only-no-external-notification',DEMO_RECIPIENT_ADDRESS:original.recipient.address,
    TEST_CATALOG:readFileSync('examples/counterparties.json','utf8'),TEST_POLICY:overrides.policy?JSON.stringify(overrides.policy):readFileSync('policies/example.yaml','utf8'),TEST_NOW:overrides.now??'2026-10-25T12:00:00Z'},
  });cleanups.push(()=>mf.dispose());await mf.ready;
  const call=(path:string,input?:unknown,token=owner)=>mf.dispatchFetch('https://backend.example.test'+path,{method:input===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});
  const tick=async(n=1)=>{for(let i=0;i<n;i++)expect((await call('/__test/tick')).status).toBe(200);};
  const bootstrap=async()=>{const r=await call('/owner/bootstrap',history);expect(r.status,await r.clone().text()).toBe(200);};
  return{mf,call,tick,bootstrap};
}
describe('actual workerd SQLite durable actor',()=>{
  it('starts locked, refuses agent import/activation and never creates an empty payment history',async()=>{
    const f=await setup();expect(await(await f.call('/health')).json()).toMatchObject({status:'awaiting_history',read_only:true});
    expect((await f.call('/api/payments',{},agent)).status).toBe(503);
    expect((await f.call('/owner/bootstrap',history,agent)).status).toBe(401);
    expect((await f.call('/owner/activate',{},agent)).status).toBe(401);
    expect((await f.call('/owner/activate',{})).status).toBe(409);
  });
  it('restores exact historical IDs/hashes and prevents re-import while remaining read-only',async()=>{
    const f=await setup();await f.bootstrap();
    expect(await(await f.call('/health')).json()).toMatchObject({read_only:true,chain_id:84532});
    const p=await(await f.call('/api/payments/'+originalId,undefined,agent)).json();expect(p).toMatchObject({id:originalId,status:'completed',transaction_hash:originalHash});
    expect((await f.call('/owner/bootstrap',history)).status).toBe(409);
    expect((await f.call('/api/payments',original,agent)).status).toBe(503);
  });
  it('rolls back corrupt history instead of partially activating the wallet',async()=>{
    const f=await setup();expect((await f.call('/owner/bootstrap',{...history,sha256:'0'.repeat(64)})).status).toBe(400);
    expect(await(await f.call('/health')).json()).toMatchObject({status:'awaiting_history'});await f.bootstrap();
  });
  it('refuses a validly checksummed snapshot for a different signing wallet',async()=>{
    const f=await setup();const payload={...history.payload,payer_address:'0x0000000000000000000000000000000000000002'};
    expect((await f.call('/owner/bootstrap',{payload,sha256:fingerprint(payload)})).status).toBe(400);
    expect(await(await f.call('/health')).json()).toMatchObject({status:'awaiting_history',read_only:true});
  });
  it('retries an old M1 key after activation without signing another transfer',async()=>{
    const f=await setup();await f.bootstrap();expect((await f.call('/owner/activate',{})).status).toBe(200);
    const p=await(await f.call('/api/payments',original,agent)).json();expect(p).toMatchObject({id:originalId,status:'completed',transaction_hash:originalHash});
    expect(await(await f.call('/__test/stats')).json()).toMatchObject({n:0});
  });
  it('runs the common ledger lifecycle and durable alarms, then stops scheduling when idle',async()=>{
    const f=await setup();await f.bootstrap();await f.call('/owner/activate',{});
    const input={idempotency_key:'new-ledger',payer:agentId,recipient:'dataco',amount:'5',destination_currency:'USD',deadline:new Date(Date.now()+86400000).toISOString(),purpose:'test ledger',max_fee:'1',reversibility_requirement:'required',recipient_preferences:{delivery:'internal'}};
    const r=await f.call('/api/payments',input,agent);expect(r.status).toBe(202);const p=await r.json() as {id:string};
    expect(await(await f.call('/__test/alarm')).json()).toMatchObject({alarm:expect.any(Number)});
    await f.tick(7);expect(await(await f.call('/api/payments/'+p.id,undefined,agent)).json()).toMatchObject({status:'completed'});
    expect(await(await f.call('/__test/alarm')).json()).toMatchObject({alarm:null});
    const retry=await(await f.call('/api/payments',input,agent)).json();expect(retry).toMatchObject({id:p.id,status:'completed'});
  });
  it('survives actor eviction after an ambiguous broadcast and reuses the same signed hash',async()=>{
    const f=await setup();await f.bootstrap();await f.call('/owner/activate',{});
    const input={idempotency_key:'native-cold-restart',payer:agentId,recipient:'dataco',amount:'5',destination_currency:'USD',deadline:new Date(Date.now()+86400000).toISOString(),purpose:'test USDC',max_fee:'1',reversibility_requirement:'none',recipient_preferences:{delivery:'wallet'}};
    const r=await f.call('/api/payments',input,agent);const p=await r.json() as {id:string};await f.tick(4);
    const before=await(await f.call('/api/payments/'+p.id,undefined,agent)).json() as {transaction_hash:string;status:string};expect(before.status).toBe('in_transit');expect(before.transaction_hash).toMatch(/^0x/);
    await f.mf.unsafeEvictDurableObject('railgate-test','TestRailgateOwner',{name:'owner'});
    const retry=await(await f.call('/api/payments',input,agent)).json();expect(retry).toMatchObject({id:p.id,transaction_hash:before.transaction_hash});
    await f.call('/__test/confirm');await f.tick(3);
    expect(await(await f.call('/api/payments/'+p.id,undefined,agent)).json()).toMatchObject({status:'completed',transaction_hash:before.transaction_hash});
    expect(await(await f.call('/__test/stats')).json()).toMatchObject({n:1});
  });
  it('serializes concurrent daily reservations in actual durable SQLite',async()=>{
    const f=await setup({policy:{...loadPolicy('policies/example.yaml'),max_per_day:'10'}});await f.bootstrap();await f.call('/owner/activate',{});
    const input={payer:agentId,recipient:'dataco',amount:'5',destination_currency:'USD',deadline:'2026-11-06T23:00:00Z',purpose:'daily test',max_fee:'1',reversibility_requirement:'required',recipient_preferences:{delivery:'internal'}};
    const responses=await Promise.all(['a','b'].map(idempotency_key=>f.call('/api/payments',{...input,idempotency_key},agent)));
    const ids=await Promise.all(responses.map(async r=>(await r.json() as {id:string}).id));await f.tick(8);
    const states=await Promise.all(ids.map(async id=>(await(await f.call('/api/payments/'+id,undefined,agent)).json() as {status:string}).status));
    expect(states.sort()).toEqual(['completed','denied']);
  });
  it('rearms orphaned durable work after eviction even when the original request lost its alarm',async()=>{
    const f=await setup();await f.bootstrap();await f.call('/owner/activate',{});
    const input={idempotency_key:'orphaned-request',payer:agentId,recipient:'dataco',amount:'5',destination_currency:'USD',deadline:'2026-11-06T23:00:00Z',purpose:'restart test',max_fee:'1',reversibility_requirement:'required',recipient_preferences:{delivery:'internal'}};
    const r=await f.call('/api/payments',input,agent);const p=await r.json() as {id:string};
    await f.call('/__test/delete-alarm');await f.mf.unsafeEvictDurableObject('railgate-test','TestRailgateOwner',{name:'owner'});
    await f.call('/api/payments/'+p.id,undefined,agent);
    expect(await(await f.call('/__test/alarm')).json()).toMatchObject({alarm:expect.any(Number)});await f.tick(7);
    expect(await(await f.call('/api/payments/'+p.id,undefined,agent)).json()).toMatchObject({status:'completed'});
  });
  it('expires human approval and releases its durable source/budget reservation',async()=>{
    const f=await setup({policy:{...loadPolicy('policies/example.yaml'),require_approval_above:'1'}});await f.bootstrap();await f.call('/owner/activate',{});
    const r=await f.call('/api/payments',{idempotency_key:'expires-on-actor',payer:agentId,recipient:'dataco',amount:'5',destination_currency:'USD',deadline:'2026-11-06T23:00:00Z',purpose:'expiry test',max_fee:'1',reversibility_requirement:'required',recipient_preferences:{delivery:'internal'}},agent);const p=await r.json() as {id:string};await f.tick(3);
    expect(await(await f.call('/api/payments/'+p.id,undefined,agent)).json()).toMatchObject({status:'pending_approval'});
    await f.call('/__test/clock',{now:'2026-10-25T12:16:00Z'});await f.tick();
    expect(await(await f.call('/api/payments/'+p.id,undefined,agent)).json()).toMatchObject({status:'expired'});
    expect(await(await f.call('/api/limits',undefined,agent)).json()).toMatchObject({spent_or_reserved_today:'5.00'});
  });
  it('keeps modeled bank settlement distinct from usable funds on the durable worker',async()=>{
    const policy={...loadPolicy('policies/example.yaml'),routing:{allowed_rails:['ach-mock']}};
    const f=await setup({policy,now:'2026-10-27T14:00:00Z'});await f.bootstrap();await f.call('/owner/activate',{});
    const r=await f.call('/api/payments',{idempotency_key:'bank-on-actor',payer:agentId,recipient:'dataco',amount:'1',destination_currency:'USD',deadline:'2026-11-06T23:00:00Z',purpose:'bank test',max_fee:'2',reversibility_requirement:'none',recipient_preferences:{delivery:'bank'}},agent);const p=await r.json() as {id:string};await f.tick(4);
    const stored=await(await f.call('/__test/quote')).json() as {quote:string};const q=JSON.parse(stored.quote) as {expected_available_at:string};
    await f.call('/__test/clock',{now:new Date(Date.parse(q.expected_available_at)-3600000).toISOString()});await f.tick();
    expect(await(await f.call('/api/payments/'+p.id,undefined,agent)).json()).toMatchObject({status:'settled'});
    await f.call('/__test/clock',{now:q.expected_available_at});await f.tick();
    expect(await(await f.call('/api/payments/'+p.id,undefined,agent)).json()).toMatchObject({status:'completed'});
  });
});
