import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { parse } from 'dotenv';
import Database from 'better-sqlite3';
import { verifyDatabase } from './restore-hosted-db.mjs';

async function main() {
  if (!process.argv.includes('--confirm-daemon-stopped')) throw new Error('Stop the local daemon before export; then use --confirm-daemon-stopped. Never run two signers with this wallet.');
  const cfg = { ...parse(readFileSync('.env', 'utf8')), ...process.env };
  const source = resolve(cfg.DATABASE_PATH ?? './data/railgate.sqlite'); verifyDatabase(source);
  const dir = resolve('data/hosting'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, 'database.sqlite');
  if (existsSync(target)) throw new Error('A hosting snapshot already exists. Preserve it separately before creating a fresh cutover export.');
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    const active = db.prepare("SELECT COUNT(*) n FROM payments WHERE funds_locked = 1 OR status IN ('created','recipient_resolved','route_selected','funds_reserved','in_transit','settled','pending_approval','queued','preparing','submitted','uncertain')").get();
    if (active.n) throw new Error('Unresolved payments exist. Finish/reconcile them before moving the signer.');
    await db.backup(target);
  } finally { db.close(); }
  chmodSync(target, 0o600); verifyDatabase(target);
  const raw = readFileSync(target);
  if (raw.length > 32 * 1024 * 1024) throw new Error('Snapshot exceeds the bootstrap limit; use a private persistent-volume restore instead');
  const encoded = gzipSync(raw).toString('base64');
  if (encoded.length > 96 * 1024) throw new Error('Snapshot exceeds the environment-variable limit; use a private persistent-volume restore instead');
  const names = ['BASE_SEPOLIA_RPC_URL','RAILGATE_PRIVATE_KEY','APPROVAL_SECRET','OWNER_API_TOKEN','AGENT_API_TOKEN','AGENT_ID','NTFY_SERVER','NTFY_TOPIC','NTFY_TOKEN','DEMO_RECIPIENT_ADDRESS','DEMO_RECIPIENT_PRIVATE_KEY','WISE_SANDBOX_TOKEN','WISE_SANDBOX_PROFILE_ID'];
  const settings = Object.fromEntries(names.filter((name) => cfg[name]).map((name) => [name, cfg[name]]));
  Object.assign(settings, { HOST: '0.0.0.0', DATABASE_PATH: '/var/data/railgate.sqlite', RAILGATE_DATABASE_BOOTSTRAP: '1', RAILGATE_DATABASE_SNAPSHOT: encoded, RAILGATE_DATABASE_SHA256: createHash('sha256').update(raw).digest('hex') });
  const output = resolve('.env.render');
  if (existsSync(output)) throw new Error('Existing .env.render preserved; review it before exporting again');
  writeFileSync(output, '# PRIVATE: import into Render environment settings. Never commit or send in chat.\n# Also set PUBLIC_BASE_URL to your actual Vercel production origin.\n' + Object.entries(settings).map(([key,value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Private database snapshot: data/hosting/database.sqlite');
  console.log('Private backend environment: .env.render (mode 0600). Import it securely into Render and set PUBLIC_BASE_URL to the Vercel origin.');
  console.log('The source database was preserved. Keep the old signer stopped during hosted cutover.');
  console.log('Initial hosted mode is READ ONLY. After verifying history, remove RAILGATE_DATABASE_BOOTSTRAP/SNAPSHOT/SHA256 and redeploy before enabling agent traffic.');
}
void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
