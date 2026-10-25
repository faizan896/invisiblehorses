import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
import Database from 'better-sqlite3';
import { ConfigSchema } from '../dist/src/config.js';
import { exportHistory } from '../dist/src/hosting/history-export.js';

try {
  const args=process.argv.slice(2), index=args.indexOf('--public-url');
  if(!args.includes('--confirm-daemon-stopped') || index<0 || !args[index+1])throw new Error('Stop the former signer, then use --confirm-daemon-stopped --public-url ACTUAL_VERCEL_ORIGIN');
  const cfg=ConfigSchema.parse({...parse(readFileSync('.env','utf8')),PUBLIC_BASE_URL:args[index+1]});
  const db=new Database(cfg.DATABASE_PATH,{readonly:true,fileMustExist:true});
  let history;try{history=exportHistory(db,privateKeyToAccount(cfg.RAILGATE_PRIVATE_KEY).address,cfg.AGENT_ID);}finally{db.close();}
  const dir=resolve('data/hosting');mkdirSync(dir,{recursive:true,mode:0o700});
  const snapshot=resolve(dir,'cloudflare-history.json'), secrets=resolve(dir,'cloudflare-secrets.json');
  if(existsSync(snapshot)||existsSync(secrets))throw new Error('Existing Cloudflare migration files preserved; archive them before a fresh export');
  const names=['BASE_SEPOLIA_RPC_URL','RAILGATE_PRIVATE_KEY','APPROVAL_SECRET','OWNER_API_TOKEN','AGENT_API_TOKEN','AGENT_ID','PUBLIC_BASE_URL','NTFY_SERVER','NTFY_TOPIC','NTFY_TOKEN','DEMO_RECIPIENT_ADDRESS','DEMO_RECIPIENT_PRIVATE_KEY','WISE_SANDBOX_TOKEN','WISE_SANDBOX_PROFILE_ID'];
  const values=Object.fromEntries(names.filter(k=>cfg[k]!==undefined).map(k=>[k,cfg[k]]));
  writeFileSync(snapshot,JSON.stringify(history),{flag:'wx',mode:0o600});writeFileSync(secrets,JSON.stringify(values),{flag:'wx',mode:0o600});
  console.log({private_history_file:snapshot,private_secrets_file:secrets,payments:history.payload.tables.find(t=>t.name==='payments').rows.length});
  console.log('Import into the verified free Cloudflare account only; keep both files out of Git, logs and chat.');
}catch(error){console.error(error.message);process.exitCode=1;}
