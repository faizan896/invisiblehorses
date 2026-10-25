import { spawn } from 'node:child_process';
import { restoreHostedDatabase } from './restore-hosted-db.mjs';

try {
  const bootstrap = process.env.RAILGATE_DATABASE_BOOTSTRAP === '1';
  const result = restoreHostedDatabase({ path: process.env.DATABASE_PATH, snapshot: process.env.RAILGATE_DATABASE_SNAPSHOT, sha256: process.env.RAILGATE_DATABASE_SHA256, allowBootstrap: bootstrap });
  console.error(`Hosted database ${result}; existing payment history preserved.`);
  const child = spawn(process.execPath, ['dist/src/cli.js', 'serve'], { stdio: 'inherit', env: { ...process.env, RAILGATE_READ_ONLY: bootstrap ? '1' : process.env.RAILGATE_READ_ONLY ?? '0' } });
  child.once('error', () => { console.error('Unable to start hosted payment daemon'); process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => child.kill(signal));
} catch { console.error('Hosted startup refused: check the persistent database and private snapshot. No payment requests accepted.'); process.exitCode = 1; }
