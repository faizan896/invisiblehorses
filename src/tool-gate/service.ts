import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SqlDatabase } from '../audit/store-core.js';
import { AppError } from '../errors.js';
import { canonicalInputHash, type ProviderAdapter, type Quote, type Outcome } from './provider.js';

const amount = z.number().int().min(0).max(1_000_000_000);
const label = z.string().min(1).max(100);
const AgentInput = z.object({ customer_id: label, name: label, per_request_limit_minor: amount, daily_limit_minor: amount }).strict();
const JobInput = z.object({ customer_id: label, name: label, budget_minor: amount, agent_ids: z.array(z.string()).min(1).max(100), tool_ids: z.array(label).min(1).max(20) }).strict();
const RequestInput = z.object({ job_id: z.string().uuid(), tool_id: label, input: z.unknown(), idempotency_key: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict();
const AgentUpdate = z.object({ active: z.boolean().optional(), per_request_limit_minor: amount.optional(), daily_limit_minor: amount.optional() }).strict();
const JobUpdate = z.object({ active: z.boolean().optional(), budget_minor: amount.optional() }).strict();
export type GateAuth = { agent_id: string; key_id: string };
export type GateOptions = { daily_limit_minor: number; per_request_limit_minor: number; approval_above_minor: number; clock?: () => Date };
type Agent = { id: string; customer_id: string; name: string; per_request_limit_minor: number; daily_limit_minor: number; active: number };
type Job = { id: string; customer_id: string; name: string; budget_minor: number; active: number; agent_ids: string; tool_ids: string };
type Row = { id: string; agent_id: string; key_id: string; customer_id: string; job_id: string; tool_id: string; mode: string; idem: string; digest: string; input: string; input_hash: string; state: string; quote: string | null; quote_id: string | null; held: number; actual: number | null; provider_ref: string | null; result: string | null; reason: string; created_at: string; updated_at: string; confirmed_at: string | null };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export class GateService {
  private busy = false;
  private providers: Map<string, ProviderAdapter>;
  constructor(readonly db: SqlDatabase, providers: ProviderAdapter[], readonly options: GateOptions) {
    amount.parse(options.daily_limit_minor); amount.parse(options.per_request_limit_minor); amount.parse(options.approval_above_minor);
    this.providers = new Map(providers.map(p => [p.id, p]));
    if (this.providers.size !== providers.length || !providers.length) throw new Error('Configure unique tool providers');
    db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000'); db.pragma('synchronous = FULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS gate_agents(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,per_request_limit_minor INTEGER NOT NULL,daily_limit_minor INTEGER NOT NULL,active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gate_keys(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES gate_agents(id),digest TEXT UNIQUE NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS gate_jobs(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,budget_minor INTEGER NOT NULL,active INTEGER NOT NULL,agent_ids TEXT NOT NULL,tool_ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gate_requests(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,key_id TEXT NOT NULL,customer_id TEXT NOT NULL,job_id TEXT NOT NULL,tool_id TEXT NOT NULL,mode TEXT NOT NULL,idem TEXT NOT NULL,digest TEXT NOT NULL,input TEXT NOT NULL,input_hash TEXT NOT NULL,state TEXT NOT NULL,quote TEXT,quote_id TEXT,held INTEGER NOT NULL DEFAULT 0,actual INTEGER,provider_ref TEXT,result TEXT,reason TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,confirmed_at TEXT,UNIQUE(agent_id,idem),UNIQUE(tool_id,quote_id));
      CREATE UNIQUE INDEX IF NOT EXISTS gate_receipt_once ON gate_requests(tool_id,provider_ref) WHERE state='confirmed';
      CREATE TABLE IF NOT EXISTS gate_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT,event TEXT NOT NULL,details TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS gate_events_no_update BEFORE UPDATE ON gate_events BEGIN SELECT RAISE(ABORT,'Audit events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS gate_events_no_delete BEFORE DELETE ON gate_events BEGIN SELECT RAISE(ABORT,'Audit events are append-only'); END;
    `);
    this.tx(() => {
      for (const r of db.prepare("SELECT * FROM gate_requests WHERE state IN ('executing','quoting')").all() as Row[])
        this.set(r.id, r.state === 'executing' ? 'uncertain' : 'failed', r.state === 'executing' ? 'Process interrupted; provider reconciliation required' : 'Interrupted before a quote; no execution was sent', r.state === 'executing' ? r.held : 0);
    });
  }
  private tx<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  private now() { return (this.options.clock?.() ?? new Date()).toISOString(); }
  private row(id: string) { const r = this.db.prepare('SELECT * FROM gate_requests WHERE id=?').get(id) as Row | undefined; if (!r) throw new AppError(404, 'Request not found'); return r; }
  private event(id: string | null, event: string, details: unknown = {}) { this.db.prepare('INSERT INTO gate_events(request_id,event,details,at) VALUES(?,?,?,?)').run(id, event, JSON.stringify(details), this.now()); }
  private set(id: string, state: string, reason: string, held: number) {
    const previous=this.row(id);
    this.db.prepare('UPDATE gate_requests SET state=?,reason=?,held=?,updated_at=? WHERE id=?').run(state, reason, held, this.now(), id);
    if(previous.state!==state || previous.reason!==reason || previous.held!==held) this.event(id, state, { reason });
  }
  private agent(auth: GateAuth) {
    const a = this.db.prepare('SELECT a.* FROM gate_agents a JOIN gate_keys k ON k.agent_id=a.id WHERE a.id=? AND k.id=? AND k.revoked=0 AND a.active=1').get(auth.agent_id, auth.key_id) as Agent | undefined;
    if (!a) throw new AppError(401, 'Agent key is invalid, revoked or paused');
    return a;
  }
  authenticate(key: string): GateAuth {
    if (!/^ih_agent_[A-Za-z0-9_-]{43}$/.test(key)) throw new AppError(401, 'Invalid agent key');
    const k = this.db.prepare('SELECT id,agent_id FROM gate_keys WHERE digest=? AND revoked=0').get(hash(key)) as {id:string;agent_id:string} | undefined;
    if (!k) throw new AppError(401, 'Invalid agent key');
    const auth = { agent_id: k.agent_id, key_id: k.id }; this.agent(auth); return auth;
  }
  createAgent(input: unknown) {
    const v = AgentInput.parse(input), id = randomUUID(), keyId = randomUUID(), key = 'ih_agent_' + randomBytes(32).toString('base64url');
    this.tx(() => {
      this.db.prepare('INSERT INTO gate_agents VALUES(?,?,?,?,?,1)').run(id, v.customer_id, v.name, v.per_request_limit_minor, v.daily_limit_minor);
      this.db.prepare('INSERT INTO gate_keys(id,agent_id,digest) VALUES(?,?,?)').run(keyId, id, hash(key));
      this.event(null, 'agent_created', { id, customer_id: v.customer_id });
    });
    return { agent: { id, ...v, active: true, key_id: keyId }, key };
  }
  updateAgent(id: string, input: unknown) {
    const v = AgentUpdate.parse(input), a = this.db.prepare('SELECT * FROM gate_agents WHERE id=?').get(id) as Agent | undefined;
    if (!a) throw new AppError(404, 'Agent not found');
    this.tx(() => { this.db.prepare('UPDATE gate_agents SET active=?,per_request_limit_minor=?,daily_limit_minor=? WHERE id=?').run(v.active === undefined ? a.active : +v.active, v.per_request_limit_minor ?? a.per_request_limit_minor, v.daily_limit_minor ?? a.daily_limit_minor, id); this.event(null, 'agent_updated', { id }); });
    return this.db.prepare('SELECT * FROM gate_agents WHERE id=?').get(id);
  }
  revokeKey(id: string) {
    const change = this.db.prepare('UPDATE gate_keys SET revoked=1 WHERE id=?').run(id);
    if (!change.changes) throw new AppError(404, 'Key not found'); this.event(null, 'key_revoked', { id }); return { revoked: true };
  }
  createJob(input: unknown) {
    const v = JobInput.parse(input), id = randomUUID();
    for (const agentId of v.agent_ids) {
      const a = this.db.prepare('SELECT customer_id FROM gate_agents WHERE id=?').get(agentId) as {customer_id:string} | undefined;
      if (!a || a.customer_id !== v.customer_id) throw new AppError(400, 'Job agents must belong to the same customer');
    }
    if (v.tool_ids.some(id => !this.providers.has(id))) throw new AppError(400, 'Unknown tool provider');
    this.tx(() => { this.db.prepare('INSERT INTO gate_jobs VALUES(?,?,?,?,1,?,?)').run(id,v.customer_id,v.name,v.budget_minor,JSON.stringify([...new Set(v.agent_ids)]),JSON.stringify([...new Set(v.tool_ids)])); this.event(null,'job_created',{id,customer_id:v.customer_id,budget_minor:v.budget_minor}); });
    return this.jobView(this.db.prepare('SELECT * FROM gate_jobs WHERE id=?').get(id) as Job);
  }
  updateJob(id: string, input: unknown) {
    const v = JobUpdate.parse(input), j = this.db.prepare('SELECT * FROM gate_jobs WHERE id=?').get(id) as Job | undefined;
    if (!j) throw new AppError(404,'Job not found');
    this.tx(() => { this.db.prepare('UPDATE gate_jobs SET active=?,budget_minor=? WHERE id=?').run(v.active===undefined ? j.active : +v.active,v.budget_minor ?? j.budget_minor,id); this.event(null,'job_updated',{id}); });
    return this.jobView(this.db.prepare('SELECT * FROM gate_jobs WHERE id=?').get(id) as Job);
  }
  private jobView(j: Job) { return { ...j, active: !!j.active, agent_ids: JSON.parse(j.agent_ids) as string[], tool_ids: JSON.parse(j.tool_ids) as string[], ...this.jobUsage(j.id) }; }
  private jobUsage(id: string, exclude = '') {
    return this.db.prepare("SELECT COALESCE(SUM(held),0) reserved_minor,COALESCE(SUM(CASE WHEN state='confirmed' THEN actual ELSE 0 END),0) spent_minor FROM gate_requests WHERE job_id=? AND id!=?").get(id,exclude) as {reserved_minor:number;spent_minor:number};
  }
  private spent(agentId?: string, exclude = '') {
    const start = new Date(this.now()); start.setUTCHours(0,0,0,0);
    const row = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN held>0 THEN held WHEN state='confirmed' AND confirmed_at>=? THEN actual ELSE 0 END),0) n FROM gate_requests WHERE id!=?" + (agentId ? ' AND agent_id=?' : '')).get(...[start.toISOString(),exclude,...(agentId ? [agentId] : [])]) as {n:number};
    return row.n;
  }
  private jobFor(auth: GateAuth, id: string, toolId: string) {
    const a = this.agent(auth), j = this.db.prepare('SELECT * FROM gate_jobs WHERE id=?').get(id) as Job | undefined;
    if (!j || j.customer_id !== a.customer_id || !(JSON.parse(j.agent_ids) as string[]).includes(a.id)) throw new AppError(404,'Job not found for this agent');
    if (!j.active || !(JSON.parse(j.tool_ids) as string[]).includes(toolId)) throw new AppError(403,'Job is paused or tool is not permitted');
    return { a, j };
  }
  private permitted(r: Row, cost: number) {
    const { a,j } = this.jobFor({agent_id:r.agent_id,key_id:r.key_id},r.job_id,r.tool_id), usage = this.jobUsage(j.id,r.id);
    if (cost > this.options.per_request_limit_minor || cost > a.per_request_limit_minor) return 'Per-request spending limit exceeded';
    if (this.spent(undefined,r.id) + cost > this.options.daily_limit_minor) return 'Company daily budget exceeded';
    if (this.spent(a.id,r.id) + cost > a.daily_limit_minor) return 'Agent daily budget exceeded';
    if (usage.spent_minor + usage.reserved_minor + cost > j.budget_minor) return 'Customer job budget exceeded';
    return null;
  }
  private expire() {
    for (const r of this.db.prepare("SELECT * FROM gate_requests WHERE state IN ('queued','pending_approval')").all() as Row[]) {
      const q = JSON.parse(r.quote!) as Quote;
      if (Date.parse(q.expires_at) <= Date.parse(this.now())) this.set(r.id,'expired','Provider quote expired before execution',0);
    }
  }
  async request(auth: GateAuth, input: unknown) {
    const v = RequestInput.parse(input);
    let inputHash: string;
    try { inputHash=canonicalInputHash(v.input); if (Buffer.byteLength(JSON.stringify(v.input) ?? '')>16384) throw new Error('Input too large'); } catch { throw new AppError(400,'Tool input must be bounded valid JSON'); }
    const digest = hash(JSON.stringify([v.job_id,v.tool_id,inputHash]));
    if(!this.providers.has(v.tool_id)) throw new AppError(403,'Configured provider is unavailable');
    const claim = this.tx(() => {
      this.jobFor(auth,v.job_id,v.tool_id); this.expire();
      const old = this.db.prepare('SELECT * FROM gate_requests WHERE agent_id=? AND idem=?').get(auth.agent_id,v.idempotency_key) as Row | undefined;
      if (old) { if (old.digest !== digest) throw new AppError(409,'Idempotency key belongs to a different request'); return {id:old.id,fresh:false}; }
      const j = this.db.prepare('SELECT customer_id FROM gate_jobs WHERE id=?').get(v.job_id) as {customer_id:string};
      const id=randomUUID(),now=this.now();
      this.db.prepare("INSERT INTO gate_requests(id,agent_id,key_id,customer_id,job_id,tool_id,mode,idem,digest,input,input_hash,state,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'quoting','Request saved before provider quote',?,?)").run(id,auth.agent_id,auth.key_id,j.customer_id,v.job_id,v.tool_id,this.providers.get(v.tool_id)!.mode,v.idempotency_key,digest,JSON.stringify(v.input),inputHash,now,now);
      this.event(id,'requested',{job_id:v.job_id,tool_id:v.tool_id,input_hash:inputHash}); return {id,fresh:true};
    });
    if (!claim.fresh) return this.getRequest(claim.id,auth);
    try {
      const quote = await this.providers.get(v.tool_id)!.quote(v.input,inputHash);
      if (!quote.id || quote.id.length>256 || quote.currency!=='USD' || quote.input_hash!==inputHash || !Number.isSafeInteger(quote.amount_minor) || quote.amount_minor<0 || quote.amount_minor>1_000_000_000 || !Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at)<=Date.parse(this.now()) || Date.parse(quote.expires_at)>Date.parse(this.now())+3_600_000) throw new Error('Invalid quote');
      this.tx(() => {
        const r = this.row(claim.id); if (r.state!=='quoting') return;
        this.db.prepare('UPDATE gate_requests SET quote=?,quote_id=? WHERE id=?').run(JSON.stringify(quote),quote.id,r.id);
        const denied = this.permitted(r,quote.amount_minor);
        this.set(r.id,denied ? 'denied' : quote.amount_minor>this.options.approval_above_minor ? 'pending_approval' : 'queued',denied ?? (quote.amount_minor>this.options.approval_above_minor ? 'Owner approval required' : 'Quoted cost reserved'),denied ? 0 : quote.amount_minor);
      });
    } catch {
      this.tx(() => { const r=this.row(claim.id); if(r.state==='quoting') this.set(r.id,'failed','Provider quote unavailable or invalid; no execution sent',0); });
    }
    return this.getRequest(claim.id,auth);
  }
  private view(r: Row) {
    return { id:r.id,agent_id:r.agent_id,customer_id:r.customer_id,job_id:r.job_id,tool_id:r.tool_id,idempotency_key:r.idem,input_hash:r.input_hash,status:r.state,quote:r.quote ? JSON.parse(r.quote) as Quote : null,reserved_minor:r.held,actual_amount_minor:r.actual,provider_request_id:r.provider_ref,reason:r.reason,created_at:r.created_at,updated_at:r.updated_at,confirmed_at:r.confirmed_at,mode:r.mode,bank_settlement_verified:false };
  }
  getRequest(id: string, auth?: GateAuth) {
    const r=this.row(id); if(auth) {this.agent(auth);if(r.agent_id!==auth.agent_id) throw new AppError(404,'Request not found');} return this.view(r);
  }
  listRequests(auth?: GateAuth) {
    if(auth)this.agent(auth);
    return (this.db.prepare('SELECT * FROM gate_requests'+(auth?' WHERE agent_id=?':'')+' ORDER BY rowid DESC LIMIT 200').all(...(auth?[auth.agent_id]:[])) as Row[]).map(r=>this.view(r));
  }
  decide(id: string, approve: boolean) {
    this.tx(() => {
      this.expire(); const r=this.row(id); if(r.state!=='pending_approval')throw new AppError(409,'Request is not awaiting approval');
      if(!approve) {this.set(id,'rejected','Rejected by owner',0);return;}
      const q=JSON.parse(r.quote!) as Quote; let denied: string|null;
      try {denied=this.permitted(r,q.amount_minor);} catch {denied='Agent access or job permission changed';}
      this.set(id,denied?'denied':'queued',denied ?? 'Owner approved the exact input and quote',denied?0:q.amount_minor);
    }); return this.getRequest(id);
  }
  cancel(id:string,auth?:GateAuth) {
    this.getRequest(id,auth);
    this.tx(()=>{const r=this.row(id);if(r.state==='cancelled')return;if(!['quoting','queued','pending_approval'].includes(r.state))throw new AppError(409,'Execution may already have started; reconcile before releasing budget');this.set(id,'cancelled','Cancelled before execution',0);}); return this.getRequest(id,auth);
  }
  async tick() {
    if(this.busy)return;this.busy=true;
    try {
      this.tx(()=>this.expire());
      const rows=[...this.db.prepare("SELECT * FROM gate_requests WHERE state='queued' ORDER BY rowid LIMIT 25").all(),...this.db.prepare("SELECT * FROM gate_requests WHERE state='uncertain' ORDER BY updated_at,rowid LIMIT 25").all()] as Row[];
      for(const before of rows) {
        let dispatch=false;
        this.tx(()=>{
          const r=this.row(before.id); if(r.state!=='queued')return;
          const q=JSON.parse(r.quote!) as Quote; let denied:string|null;
          if(Date.parse(q.expires_at)<=Date.parse(this.now())){this.set(r.id,'expired','Provider quote expired before execution',0);return;}
          if(this.providers.get(r.tool_id)?.mode!==r.mode){this.set(r.id,'denied','Provider mode changed before execution',0);return;}
          try {denied=this.permitted(r,q.amount_minor);}catch {denied='Agent access or job permission changed';}
          if(denied){this.set(r.id,'denied',denied,0);return;}
          this.set(r.id,'executing','Execution key persisted before provider call',q.amount_minor);dispatch=true;
        });
        const r=this.row(before.id);if(!dispatch&&r.state!=='uncertain')continue;
        const provider=this.providers.get(r.tool_id);
        if(!provider || provider.mode!==r.mode){this.tx(()=>this.set(r.id,'uncertain','Configured provider is unavailable or changed; reservation retained',r.held));continue;}
        if(dispatch)try{await provider.execute(JSON.parse(r.quote!) as Quote,r.id,JSON.parse(r.input));}catch{ /* A timeout is not evidence of failure or permission to retry execution. */ }
        try {const outcome=await provider.reconcile(r.id);this.accept(r,outcome);}catch{this.tx(()=>{const latest=this.row(r.id);if(latest.state!=='confirmed')this.set(r.id,'uncertain','Provider outcome unconfirmed; reservation retained',latest.held);});}
      }
    } finally {this.busy=false;}
  }
  private accept(before:Row,outcome:Outcome) {
    this.tx(()=>{
      const r=this.row(before.id),q=JSON.parse(r.quote!) as Quote;
      if(r.state==='confirmed')return;
      if(outcome.state==='pending'){this.set(r.id,'uncertain','Provider lookup is pending; reservation retained',r.held);return;}
      if(outcome.request_id!==r.id || outcome.quote_id!==q.id || outcome.input_hash!==r.input_hash || outcome.currency!=='USD' || !outcome.provider_request_id || outcome.provider_request_id.length>256)throw new Error('Provider receipt binding mismatch');
      if(outcome.state==='failed') {
        if(outcome.amount_minor!==0)throw new Error('Failed execution reports a charge');
        this.set(r.id,'failed','Provider status confirmed no charge',0);return;
      }
      const actual=outcome.amount_minor;
      if(!Number.isSafeInteger(actual)||actual===undefined||actual<0||actual>1_000_000_000)throw new Error('Invalid confirmed amount');
      if(actual>q.amount_minor){this.db.prepare('UPDATE gate_requests SET actual=? WHERE id=?').run(actual,r.id);this.set(r.id,'uncertain','Provider reported a charge above the quote; operator investigation required',Math.max(actual,r.held));return;}
      this.db.prepare("UPDATE gate_requests SET state='confirmed',held=0,actual=?,provider_ref=?,result=?,reason='Provider status lookup confirmed the quoted execution',updated_at=?,confirmed_at=? WHERE id=?").run(actual,outcome.provider_request_id,JSON.stringify(outcome.result ?? null),this.now(),this.now(),r.id);
      this.event(r.id,'provider_confirmed',{provider_request_id:outcome.provider_request_id,actual_amount_minor:actual,mode:this.providers.get(r.tool_id)?.mode});
    });
  }
  receipt(id:string,auth?:GateAuth) {
    const visible=this.getRequest(id,auth),r=this.row(id);
    if(r.state!=='confirmed')throw new AppError(409,'No confirmed provider receipt is available');
    return { request:visible,provider_request_id:r.provider_ref,quoted_amount_minor:(JSON.parse(r.quote!) as Quote).amount_minor,actual_amount_minor:r.actual,currency:'USD',result:JSON.parse(r.result??'null') as unknown,verification:visible.mode==='sandbox'?'sandbox_fixture':'provider_status_lookup',provider_reported_charge:visible.mode==='external',external_payment:false,bank_settlement_verified:false };
  }
  snapshot() {
    return {company:{daily_limit_minor:this.options.daily_limit_minor,per_request_limit_minor:this.options.per_request_limit_minor,approval_above_minor:this.options.approval_above_minor,used_and_reserved_today_minor:this.spent()},agents:this.db.prepare('SELECT * FROM gate_agents').all(),keys:this.db.prepare('SELECT id,agent_id,revoked FROM gate_keys').all(),jobs:(this.db.prepare('SELECT * FROM gate_jobs').all() as Job[]).map(j=>this.jobView(j)),requests:this.listRequests(),audit:this.db.prepare('SELECT * FROM gate_events ORDER BY sequence DESC LIMIT 100').all(),providers:[...this.providers.values()].map(p=>({id:p.id,mode:p.mode})),bank_settlement_verified:false};
  }
}
