import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = process.argv[2] ?? 'railgate-hosting:test';
if (!/^[a-z0-9][a-z0-9./:_-]*$/.test(image)) throw new Error('Invalid test image name');
const volume = `railgate-smoke-${randomUUID()}`;
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
const common = `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Store } from './dist/src/audit/store.js';
import { PaymentService } from './dist/src/executor/service.js';
import { ApprovalTokens } from './dist/src/approval/tokens.js';
import { loadPolicy } from './dist/src/policy/loader.js';
import { createApp } from './dist/src/http/app.js';
import { assertChainId } from './dist/src/rails/usdc-base-sepolia.js';
assert.equal(process.getuid(),1000);
for(const file of ['.env','.env.mcp','.env.render']) assert.equal(existsSync(file),false);
assert.throws(()=>assertChainId(8453));
const store=new Store('/var/data/railgate.sqlite');
store.db.exec('CREATE TABLE IF NOT EXISTS hosting_smoke(id INTEGER PRIMARY KEY)');
`;
const run = (code) => docker(['run','--rm','--mount',`type=volume,source=${volume},target=/var/data`,image,'node','--input-type=module','-e',code]);
try {
  docker(['volume','create',volume]);
  run(common + `store.db.prepare('INSERT INTO hosting_smoke VALUES(1)').run();store.close();`);
  run(common + `
assert.equal(store.db.prepare('SELECT COUNT(*) n FROM hosting_smoke').get().n,1);
const executor={assertTestnet:async()=>{},prepare:async()=>{throw new Error('MOCK must never sign')},broadcast:async()=>{throw new Error('MOCK must never broadcast')},receipt:async()=>'pending'};
const service=new PaymentService(store,()=>loadPolicy('policies/example.yaml'),new ApprovalTokens('synthetic-signing-secret-for-container-smoke-only'),{notify:async()=>{throw new Error('MOCK must never publish')}},executor,'https://container.example.test');
const app=createApp(service,{ownerToken:'synthetic-owner',agentToken:'synthetic-agent',agentId:'research-agent-07',readOnly:true});
assert.equal((await app.request('/health')).status,200);
assert.equal((await app.request('/dashboard')).status,401);
assert.equal((await app.request('/dashboard',{headers:{Authorization:'Bearer synthetic-owner'}})).status,200);
assert.equal((await app.request('/api/payments',{method:'POST',headers:{Authorization:'Bearer synthetic-agent'},body:'{}'})).status,503);
store.close();
`);
  let refused = false;
  try { docker(['run','--rm',image]); } catch (error) { refused = error.status === 1 && String(error.stderr).includes('Hosted startup refused'); }
  if (!refused) throw new Error('Hosted startup must refuse a missing payment database');
  console.log('Container smoke passed: unprivileged runtime, SQLite survives container restart, guarded mainnet check, protected dashboard, read-only payment writes and missing-database refusal. RPC/notification interfaces are explicit mocks; no external calls or payment.');
} finally { docker(['volume','rm',volume]); }
