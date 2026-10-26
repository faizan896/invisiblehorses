import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ConfigSchema } from '../config.js';
import { StoreCore } from '../audit/store-core.js';
import { createApp } from '../http/app.js';
import { DurableSqlite, type DurableStorage } from './sqlite.js';
import { importHistory } from './history.js';
import { createDurableService, realNative, type Native } from './factory.js';
import catalog from '../../examples/counterparties.json' with { type: 'json' };
import policyYaml from '../../policies/example.yaml';

export interface WorkerEnv {
  OWNER: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  [name: string]: unknown;
}
export interface ActorState { storage: DurableStorage; blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> }
type ContextRow = { id: string; status: string; created_at: string; context: string | null; expires_at: string | null };

/** A single durable SQLite actor owns all reservations and signing for this owner. */
export class RailgateOwner {
  protected readonly db: DurableSqlite;
  protected cfg!: ReturnType<typeof ConfigSchema.parse>;
  protected native!: Native;
  protected services?: Awaited<ReturnType<typeof createDurableService>>;
  private ready: Promise<void>;
  private creating?: Promise<Awaited<ReturnType<typeof createDurableService>>>;
  constructor(protected readonly state: ActorState, protected readonly env: WorkerEnv) {
    this.db = new DurableSqlite(state.storage);
    this.ready = state.blockConcurrencyWhile(async () => {
      this.cfg = ConfigSchema.parse(env);
      this.native = await this.makeNative();
      this.db.exec('CREATE TABLE IF NOT EXISTS railgate_hosted_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      if (this.meta('history_hash')) { await this.getServices(); await this.schedule(); }
    });
  }
  protected makeNative(): Promise<Native> { return realNative(this.cfg); }
  protected async makeServices(store: StoreCore) { return createDurableService(store, this.state.storage, this.cfg, catalog, policyYaml, this.native); }
  private getServices() {
    return this.creating ??= this.makeServices(new StoreCore(this.db)).then(value => { this.services = value; return value; }).catch(error => { this.creating=undefined; throw error; });
  }
  private meta(key: string) { return (this.db.prepare('SELECT value FROM railgate_hosted_meta WHERE key = ?').get(key) as {value:string}|undefined)?.value; }
  private active() { return this.meta('active') === '1' && !this.cfg.RAILGATE_READ_ONLY; }
  private owner(request: Request) {
    const candidate = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
    return timingSafeEqual(createHash('sha256').update(candidate).digest(), createHash('sha256').update(this.cfg.OWNER_API_TOKEN).digest());
  }
  async fetch(request: Request): Promise<Response> {
    try {
      await this.ready;
      const path = new URL(request.url).pathname;
      if (['/owner/bootstrap','/owner/activate'].includes(path)) {
        if (!this.owner(request)) return Response.json({ error: 'Owner authentication required' }, {status:401});
        if (request.method !== 'POST') return new Response('POST required', {status:405});
        if (path === '/owner/bootstrap') {
          if (this.meta('history_hash')) return Response.json({error:'History already imported; replacement is forbidden'}, {status:409});
          const text = await request.text(); if (text.length > 2 * 1024 * 1024) return new Response('History snapshot too large', {status:413});
          try {
            const result = importHistory(this.db, JSON.parse(text), this.native.address, this.cfg.AGENT_ID);
            await this.getServices(); await this.state.storage.sync();
            return Response.json({status:'history_imported',...result,read_only:true}, {headers:{'Cache-Control':'no-store'}});
          } catch { return Response.json({error:'History restore refused; check its checksum, wallet identity and empty destination'}, {status:400}); }
        }
        if (!this.meta('history_hash')) return Response.json({error:'History must be imported before activation'}, {status:409});
        z.strictObject({}).parse(await request.json());
        this.db.prepare("UPDATE railgate_hosted_meta SET value='1' WHERE key='active'").run();
        await this.state.storage.sync(); await this.schedule();
        return Response.json({status:'active',read_only:!this.active()}, {headers:{'Cache-Control':'no-store'}});
      }
      if (!this.meta('history_hash')) {
        return Response.json({status:'awaiting_history',chain_id:84532,test_money_only:true,read_only:true}, {status:path==='/health'?200:503,headers:{'Cache-Control':'no-store'}});
      }
      const {service,quotes,routing,resources} = await this.getServices();
      const app = createApp(service,{ownerToken:this.cfg.OWNER_API_TOKEN,agentToken:this.cfg.AGENT_API_TOKEN,agentId:this.cfg.AGENT_ID,readOnly:!this.active()},quotes,routing,resources);
      const response = await app.fetch(request);
      if (request.method === 'POST') { await this.state.storage.sync(); await this.schedule(); }
      return response;
    } catch { return Response.json({error:'Payment backend unavailable; retry with the SAME idempotency key.'},{status:503,headers:{'Cache-Control':'no-store'}}); }
  }
  async alarm() {
    await this.ready;
    if (!this.meta('history_hash') || !this.active()) return;
    try { const {service,resources} = await this.getServices(); await service.tick(); await resources.tick(); await this.state.storage.sync(); await this.schedule(); }
    catch { await this.state.storage.setAlarm(Date.now()+30000); }
  }
  /** Sleep between necessary steps. There is no always-running interval or free-tier keepalive. */
  private async schedule() {
    if (!this.active() || !this.services) return;
    const now=Date.now(); let next=Infinity;
    const rows=this.db.prepare(`SELECT p.id,p.status,p.created_at,c.context,a.expires_at FROM payments p
      LEFT JOIN payment_contexts c ON c.payment_id=p.id LEFT JOIN approvals a ON a.payment_id=p.id
      WHERE p.status NOT IN ('completed','denied','rejected','expired','returned') OR (p.status='completed' AND c.context LIKE '%"returning":true%')`).all() as ContextRow[];
    for(const row of rows){
      if(row.status==='pending_approval'){if(row.expires_at)next=Math.min(next,Date.parse(row.expires_at));continue;}
      if(['created','recipient_resolved','route_selected','funds_reserved','queued','preparing','submitted'].includes(row.status)){next=Math.min(next,now+1000);continue;}
      const data=row.context?JSON.parse(row.context):null;
      const op=data?.operation?this.db.prepare('SELECT state,payout_done FROM rail_operations WHERE id=?').get(data.operation) as {state:string;payout_done:number}|undefined:undefined;
      if(row.status==='failed' && !data?.returning && op?.state!=='submitted')continue;
      if(op && ['uncertain','return-uncertain','failed-return'].includes(op.state))continue;
      const q=data?.quote;
      if(q?.destination_form==='bank' && !data.returning && (q.rail!=='usdc-base-sepolia'||op?.state==='settled')){
        const available=Date.parse(q.expected_available_at), settled=available-3600000;
        next=Math.min(next,settled>now?settled:available>now?available:now+2000);
      }else{
        const age=now-Date.parse(row.created_at),delay=age>3600000?300000:age>120000?30000:2000;
        next=Math.min(next,now+delay);
      }
    }
    if(Number.isFinite(next)){
      const existing=await this.state.storage.getAlarm();
      if(existing===null||existing>next||existing<now)await this.state.storage.setAlarm(Math.max(now+500,next));
    }else if(await this.state.storage.getAlarm()!==null)await this.state.storage.deleteAlarm();
  }
}

export default {
  fetch(request: Request, env: WorkerEnv) { return env.OWNER.get(env.OWNER.idFromName('owner')).fetch(request); },
};
