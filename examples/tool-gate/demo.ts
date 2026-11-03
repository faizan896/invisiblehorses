import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { GateService } from '../../src/tool-gate/service.js';
import { SandboxToolProvider } from '../../src/tool-gate/provider.js';
import { toolGateApp } from '../../src/tool-gate/http.js';
const db = new Database(':memory:');
const gate = new GateService(db, [
  new SandboxToolProvider({id:'small-data',amount_minor:25}),
  new SandboxToolProvider({id:'larger-data',amount_minor:75}),
],{daily_limit_minor:500,per_request_limit_minor:200,approval_above_minor:50});
const owner = randomBytes(32).toString('base64url'), app=toolGateApp(gate,owner);
async function call(path:string,key:string,body?:unknown) {
 const r=await app.request(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+key,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const value=await r.json() as Record<string,unknown>;if(!r.ok)throw new Error('Demo API failed: '+r.status);return value;
}
try {
 const issued=await call('/owner/agents',owner,{customer_id:'example-customer',name:'Research agent',per_request_limit_minor:100,daily_limit_minor:200});
 const agent=issued.agent as {id:string}, key=issued.key as string;
 const job=await call('/owner/jobs',owner,{customer_id:'example-customer',name:'Research job',budget_minor:120,agent_ids:[agent.id],tool_ids:['small-data','larger-data']});
 const request=(tool_id:string,idempotency_key:string)=>call('/v1/requests',key,{job_id:job.id,tool_id,input:{query:'Example research'},idempotency_key});
 const a=await request('small-data','research_1');await gate.tick();const receipt=await call('/v1/requests/'+a.id+'/receipt',key);
 const b=await request('larger-data','research_2');if(b.status!=='pending_approval')throw new Error('Expected owner approval');
 await call('/owner/requests/'+b.id+'/approve',owner,{});await gate.tick();
 const denied=await request('larger-data','over_job_budget');
 const retry=await request('small-data','research_1');
 if(denied.status!=='denied'||retry.id!==a.id)throw new Error('Budget or idempotency check failed');
 console.log(JSON.stringify({mode:'sandbox',real_money_moved:false,completed_request:a.id,receipt_verification:receipt.verification,owner_approved_request:b.id,over_budget_status:denied.status,retry_reused_request:retry.id===a.id,job_budget_minor:120,job_spent_minor:gate.snapshot().jobs[0]?.spent_minor,currency:'USD',note:'Configured fixture credits, not vendor prices or a bank receipt.'},null,2));
} finally {db.close();}
