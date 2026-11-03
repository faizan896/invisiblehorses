import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GateService, type GateOptions } from '../src/tool-gate/service.js';
import { canonicalInputHash, type ProviderAdapter, type Quote, type Outcome } from '../src/tool-gate/provider.js';
const databases: Database.Database[]=[]; afterEach(()=>databases.splice(0).forEach(db=>db.close()));
class Probe implements ProviderAdapter {
  id='data'; mode='sandbox' as const; cost=25; executions=0; quotes=0; pending=false; timeout=false; mismatch=false; over=false; collision=false; failed=false;
  outcomes=new Map<string,Outcome>(); clock=()=>new Date();
  async quote(input:unknown,input_hash:string):Promise<Quote> {this.quotes++;return{id:randomUUID(),amount_minor:this.cost,currency:'USD',input_hash,expires_at:new Date(+this.clock()+300000).toISOString()};}
  async execute(q:Quote,id:string,input:unknown):Promise<Outcome> {
    expect(canonicalInputHash(input)).toBe(q.input_hash);this.executions++;
    const o:Outcome={state:this.failed?'failed':'confirmed',request_id:id,provider_request_id:this.collision?'one-charge':'charge_'+id,quote_id:q.id,input_hash:q.input_hash,currency:'USD',amount_minor:this.failed?0:this.over?q.amount_minor+100:q.amount_minor,result:{answer:'data'}} as Outcome;
    this.outcomes.set(id,o);if(this.timeout)throw new Error('Provider connection interrupted after accepting request');return o;
  }
  async reconcile(id:string):Promise<Outcome> {if(this.pending)return{state:'pending',request_id:id};const o=this.outcomes.get(id)!;return this.mismatch?{...o,input_hash:'wrong'}:o;}
}
function setup(options:Partial<GateOptions>={}) {
 const db=new Database(':memory:');databases.push(db);const provider=new Probe();
 const gate=new GateService(db,[provider],{daily_limit_minor:1000,per_request_limit_minor:500,approval_above_minor:100,...options});
 if(options.clock)provider.clock=options.clock;
 const issued=gate.createAgent({customer_id:'customer-a',name:'Research agent',per_request_limit_minor:500,daily_limit_minor:1000});
 const auth=gate.authenticate(issued.key);const job=gate.createJob({customer_id:'customer-a',name:'Research job',budget_minor:500,agent_ids:[auth.agent_id],tool_ids:['data']});
 const request=(key:string,input:unknown={query:'research'})=>gate.request(auth,{job_id:job.id,tool_id:'data',input,idempotency_key:key});
 return {db,gate,provider,issued,auth,job,request};
}
describe('company billable-tool spending gate',()=>{
 it('atomically reserves one customer job across concurrent requests',async()=>{
  const s=setup();s.provider.cost=40;s.gate.updateJob(s.job.id,{budget_minor:100});
  const results=await Promise.all(Array.from({length:5},(_,i)=>s.request('parallel_'+i)));
  expect(results.filter(r=>r.status==='queued')).toHaveLength(2);expect(results.filter(r=>r.status==='denied')).toHaveLength(3);
  expect(s.gate.snapshot().jobs[0]).toMatchObject({reserved_minor:80,spent_minor:0});
  await s.gate.tick();expect(s.provider.executions).toBe(2);expect(s.gate.snapshot().jobs[0]).toMatchObject({reserved_minor:0,spent_minor:80});
 });
 it('rejects cross-customer and unassigned-agent access before asking a provider',async()=>{
  const s=setup();const other=s.gate.createAgent({customer_id:'customer-b',name:'Other',per_request_limit_minor:100,daily_limit_minor:100});
  await expect(s.gate.request(s.gate.authenticate(other.key),{job_id:s.job.id,tool_id:'data',input:{},idempotency_key:'wrong_customer'})).rejects.toMatchObject({status:404});
  expect(s.provider.quotes).toBe(0);const r=await s.request('own');
  expect(()=>s.gate.getRequest(r.id,s.gate.authenticate(other.key))).toThrow('Request not found');
 });
 it('makes retries idempotent and never executes from read-only calls',async()=>{
  const s=setup();const [a,b]=await Promise.all([s.request('once'),s.request('once')]);expect(a.id).toBe(b.id);
  await expect(s.request('once',{query:'changed'})).rejects.toMatchObject({status:409});
  s.gate.getRequest(a.id);s.gate.listRequests(s.auth);s.gate.snapshot();expect(s.provider.executions).toBe(0);
  await s.gate.tick();await s.gate.tick();await s.request('once');expect(s.provider.executions).toBe(1);
  expect(s.gate.receipt(a.id,s.auth)).toMatchObject({verification:'sandbox_fixture',provider_reported_charge:false,bank_settlement_verified:false,actual_amount_minor:25});
 });
 it('waits for owner approval and binds it to the persisted quote',async()=>{
  const s=setup({approval_above_minor:20});const r=await s.request('approval');expect(r.status).toBe('pending_approval');
  await s.gate.tick();expect(s.provider.executions).toBe(0);
  const q=r.quote;s.gate.decide(r.id,true);await s.gate.tick();expect(s.gate.getRequest(r.id).quote).toEqual(q);expect(s.provider.executions).toBe(1);
 });
 it('expires an approval without executing or retaining unused budget',async()=>{
  let now=Date.now();const s=setup({approval_above_minor:20,clock:()=>new Date(now)});const r=await s.request('expires');now+=300001;
  await s.gate.tick();expect(s.gate.getRequest(r.id)).toMatchObject({status:'expired',reserved_minor:0});expect(s.provider.executions).toBe(0);
 });
 it.each(['pause','revoke','lower-job','lower-agent'] as const)('rechecks %s immediately before provider execution',async(change)=>{
  const s=setup();const r=await s.request('recheck');
  if(change==='pause')s.gate.updateAgent(s.auth.agent_id,{active:false});
  if(change==='revoke')s.gate.revokeKey(s.auth.key_id);
  if(change==='lower-job')s.gate.updateJob(s.job.id,{budget_minor:0});
  if(change==='lower-agent')s.gate.updateAgent(s.auth.agent_id,{per_request_limit_minor:0});
  await s.gate.tick();expect(s.gate.getRequest(r.id)).toMatchObject({status:'denied',reserved_minor:0});expect(s.provider.executions).toBe(0);
 });
 it('does not let owner approval override a lowered hard budget',async()=>{
  const s=setup({approval_above_minor:20});const r=await s.request('no_override');s.gate.updateJob(s.job.id,{budget_minor:20});
  expect(s.gate.decide(r.id,true).status).toBe('denied');await s.gate.tick();expect(s.provider.executions).toBe(0);
 });
 it('shares company daily reservations across different customers and agents',async()=>{
  const s=setup({daily_limit_minor:40});
  const other=s.gate.createAgent({customer_id:'customer-b',name:'B',per_request_limit_minor:100,daily_limit_minor:100});
  const auth=s.gate.authenticate(other.key);const job=s.gate.createJob({customer_id:'customer-b',name:'B job',budget_minor:100,agent_ids:[auth.agent_id],tool_ids:['data']});
  await s.request('first');const denied=await s.gate.request(auth,{job_id:job.id,tool_id:'data',input:{},idempotency_key:'second'});
  expect(denied).toMatchObject({status:'denied',reason:'Company daily budget exceeded'});
 });
 it('cancels only before execution and frees the reservation once',async()=>{
  const s=setup();s.gate.updateJob(s.job.id,{budget_minor:25});const r=await s.request('cancel');
  s.gate.cancel(r.id,s.auth);s.gate.cancel(r.id,s.auth);expect(s.gate.snapshot().jobs[0]?.reserved_minor).toBe(0);
  const next=await s.request('next');await s.gate.tick();expect(s.provider.executions).toBe(1);expect(()=>s.gate.cancel(next.id,s.auth)).toThrow('Execution may already');
 });
 it('holds ambiguous charges through restart and reconciles without re-executing',async()=>{
  const s=setup();s.provider.pending=true;s.provider.timeout=true;const r=await s.request('unknown');await s.gate.tick();
  expect(s.gate.getRequest(r.id)).toMatchObject({status:'uncertain',reserved_minor:25});expect(()=>s.gate.cancel(r.id)).toThrow();
  const restarted=new GateService(s.db,[s.provider],s.gate.options);s.provider.pending=false;await restarted.tick();
  expect(restarted.getRequest(r.id)).toMatchObject({status:'confirmed',reserved_minor:0,actual_amount_minor:25});expect(s.provider.executions).toBe(1);
 });
 it('recovers a process interrupted after persisting execution without retrying it',async()=>{
  const s=setup();const r=await s.request('crash');const q=r.quote!;
  s.db.prepare("UPDATE gate_requests SET state='executing' WHERE id=?").run(r.id);await s.provider.execute(q,r.id,{query:'research'});
  const restarted=new GateService(s.db,[s.provider],s.gate.options);expect(restarted.getRequest(r.id).status).toBe('uncertain');await restarted.tick();expect(restarted.getRequest(r.id).status).toBe('confirmed');expect(s.provider.executions).toBe(1);
 });
 it('refuses mismatched provider receipts and keeps their reservation',async()=>{
  const s=setup();s.provider.mismatch=true;const r=await s.request('mismatch');await s.gate.tick();expect(s.gate.getRequest(r.id)).toMatchObject({status:'uncertain',reserved_minor:25});expect(()=>s.gate.receipt(r.id)).toThrow('No confirmed');
 });
 it('surfaces a provider overcharge and accounts for its full possible liability',async()=>{
  const s=setup();s.provider.over=true;const r=await s.request('over');await s.gate.tick();expect(s.gate.getRequest(r.id)).toMatchObject({status:'uncertain',reserved_minor:125,actual_amount_minor:125});expect(()=>s.gate.receipt(r.id)).toThrow();
 });
 it('cannot attach one provider charge reference to two requests',async()=>{
  const s=setup();s.provider.collision=true;const a=await s.request('charge_a'),b=await s.request('charge_b');await s.gate.tick();
  expect(s.gate.getRequest(a.id).status).toBe('confirmed');expect(s.gate.getRequest(b.id)).toMatchObject({status:'uncertain',reserved_minor:25});
 });
 it('releases a confirmed no-charge failure and hides credentials in snapshots',async()=>{
  const s=setup();s.provider.failed=true;const r=await s.request('failed');await s.gate.tick();expect(s.gate.getRequest(r.id)).toMatchObject({status:'failed',reserved_minor:0});
  const exported=JSON.stringify(s.gate.snapshot());expect(exported).not.toContain(s.issued.key);expect(exported).not.toContain('digest');
  expect(()=>s.db.prepare("DELETE FROM gate_events").run()).toThrow('append-only');
 });
 it('carries open reservations over UTC midnight and counts confirmed costs on their settlement day',async()=>{
  let now=Date.parse('2030-01-01T23:59:59Z');const s=setup({daily_limit_minor:40,clock:()=>new Date(now)});
  const r=await s.request('old_day');now+=10000;expect((await s.request('new_day')).status).toBe('denied');await s.gate.tick();expect(s.gate.getRequest(r.id).status).toBe('confirmed');
  now+=86400000;expect((await s.request('next_day')).status).toBe('queued');
 });
});

describe('dispatch and integration boundaries',()=>{
 it('rechecks quote expiry after a slow earlier execution in the same batch',async()=>{
  let now=Date.now();const s=setup({clock:()=>new Date(now)});const first=await s.request('slow'),second=await s.request('late');
  const execute=s.provider.execute.bind(s.provider);s.provider.execute=async(q,id,input)=>{const result=await execute(q,id,input);now+=300001;return result;};
  await s.gate.tick();expect(s.gate.getRequest(first.id).status).toBe('confirmed');expect(s.gate.getRequest(second.id).status).toBe('expired');expect(s.provider.executions).toBe(1);
 });
 it('does not let a backlog of unknown outcomes starve new approved work',async()=>{
  const s=setup({daily_limit_minor:100000});s.gate.updateAgent(s.auth.agent_id,{daily_limit_minor:100000});s.gate.updateJob(s.job.id,{budget_minor:100000});s.provider.pending=true;
  await Promise.all(Array.from({length:25},(_,i)=>s.request('backlog_'+i)));await s.gate.tick();const next=await s.request('new_work');await s.gate.tick();
  expect(s.provider.executions).toBe(26);expect(s.gate.getRequest(next.id).status).toBe('uncertain');
 });
 it('persists receipt mode and will not turn queued sandbox work into an external execution',async()=>{
  const s=setup();const complete=await s.request('historical');await s.gate.tick();const queued=await s.request('must_not_execute');
  const external:ProviderAdapter={id:'data',mode:'external',quote:s.provider.quote.bind(s.provider),execute:s.provider.execute.bind(s.provider),reconcile:s.provider.reconcile.bind(s.provider)};
  const changed=new GateService(s.db,[external],s.gate.options);expect(changed.receipt(complete.id).verification).toBe('sandbox_fixture');await changed.tick();expect(changed.getRequest(queued.id).status).toBe('denied');expect(s.provider.executions).toBe(1);
 });
 it('returns a client error for non-JSON tool input',async()=>{
  const s=setup();await expect(s.request('non_json',{bad:NaN})).rejects.toMatchObject({status:400});
 });
});

it('bounds multibyte tool input by UTF-8 bytes rather than character count',async()=>{const s=setup();await expect(s.request('large_unicode',{text:'界'.repeat(6000)})).rejects.toMatchObject({status:400});expect(s.provider.quotes).toBe(0);});
