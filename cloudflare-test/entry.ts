import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, type Hex } from 'viem';
import worker, { RailgateOwner } from '../src/workers/entry.js';
import type { Native } from '../src/workers/factory.js';
import { createDurableService } from '../src/workers/factory.js';
import type { StoreCore } from '../src/audit/store-core.js';

/** TEST ENTRY ONLY. Never referenced by the production wrangler configuration. */
export class TestRailgateOwner extends RailgateOwner {
  private testTime = new Date(String(this.env.TEST_NOW ?? '2026-10-25T12:00:00Z'));
  protected async makeNative(): Promise<Native> {
    this.db.exec('CREATE TABLE IF NOT EXISTS test_transport(id TEXT PRIMARY KEY, raw TEXT, sent INTEGER DEFAULT 0,confirmed INTEGER DEFAULT 0)');
    return {address:privateKeyToAccount(this.cfg.RAILGATE_PRIVATE_KEY as Hex).address,balanceMinor:async()=>100000,executor:{
      assertTestnet:async()=>{},
      prepare:async(intent)=>{const count=(this.db.prepare('SELECT COUNT(*) n FROM test_transport').get() as {n:number}).n;const raw=toHex(JSON.stringify({intent,sequence:count+1})),hash=keccak256(raw);this.db.prepare('INSERT INTO test_transport(id,raw) VALUES(?,?)').run(hash,raw);return{raw,hash};},
      broadcast:async(raw)=>{const hash=keccak256(raw);const persisted=this.db.prepare('SELECT hash FROM rail_operations WHERE raw=?').get(raw);if(!persisted)throw new Error('Signed bytes not persisted');this.db.prepare('UPDATE test_transport SET sent=1 WHERE id=?').run(hash);throw new Error('Simulated timeout AFTER acceptance');},
      receipt:async(hash)=>{const r=this.db.prepare('SELECT confirmed FROM test_transport WHERE id=?').get(hash) as {confirmed:number}|undefined;return r?.confirmed?'success':'pending';},
    }};
  }
  protected makeServices(store: StoreCore) { return createDurableService(store,this.state.storage,this.cfg,JSON.parse(String(this.env.TEST_CATALOG)),String(this.env.TEST_POLICY),this.native,{notify:async()=>{}},()=>this.testTime); }
  async fetch(request: Request) {
    if(new URL(request.url).pathname==='/__test/tick') {await this.alarm();return Response.json({ok:true});}
    if(new URL(request.url).pathname==='/__test/stats') {const records=this.db.prepare('SELECT COUNT(*) n FROM test_transport').get();return Response.json(records);}
    if(new URL(request.url).pathname==='/__test/confirm') {this.db.prepare('UPDATE test_transport SET confirmed=1 WHERE sent=1').run();return Response.json({ok:true});}
    if(new URL(request.url).pathname==='/__test/alarm')return Response.json({alarm:await this.state.storage.getAlarm()});
    if(new URL(request.url).pathname==='/__test/clock') {const body=await request.json() as {now:string};this.testTime=new Date(body.now);return Response.json({ok:true});}
    if(new URL(request.url).pathname==='/__test/quote') {return Response.json(this.db.prepare('SELECT quote FROM rail_operations ORDER BY rowid DESC LIMIT 1').get());}
    if(new URL(request.url).pathname==='/__test/delete-alarm') {await this.state.storage.deleteAlarm();return Response.json({ok:true});}
    return super.fetch(request);
  }
}
export default worker;
