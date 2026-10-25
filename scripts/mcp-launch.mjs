import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { z } from 'zod';

export const ClientSettings = z.strictObject({
  RAILGATE_API_URL: z.url().refine((s) => {
    const u = new URL(s);
    return !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  }, 'Use an HTTPS origin, or a loopback HTTP origin'),
  RAILGATE_AGENT_TOKEN: z.string().min(32),
});

export function childEnvironment(settings, parent = process.env) {
  const network = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];
  return { ...Object.fromEntries(network.filter((key) => parent[key] !== undefined).map((key) => [key, parent[key]])), ...ClientSettings.parse(settings) };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--config')) throw new Error('Usage: node scripts/mcp-launch.mjs [--config private-file]');
  // The agent launcher never opens the owner's .env file.
  const path = args[1] ? resolve(args[1]) : fileURLToPath(new URL('../.env.mcp', import.meta.url));
  const settings = ClientSettings.parse(parse(readFileSync(path, 'utf8')));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 'mcp'], { env: childEnvironment(settings), stdio: 'inherit' });
  child.once('error', () => { console.error('Unable to start railgate MCP. Run pnpm build first.'); process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { console.error('MCP client settings unavailable. Run pnpm setup:mcp; keep only the API origin and agent token in .env.mcp.'); process.exitCode = 1; }
}
