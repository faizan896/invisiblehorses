import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { ClientSettings } from './mcp-launch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--api-url')) throw new Error('Usage: pnpm setup:mcp [--api-url https://your-deployment]');
const path = join(root, '.env.mcp');
let settings;
if (existsSync(path)) {
  settings = ClientSettings.parse(parse(readFileSync(path, 'utf8')));
  if (args[1]) settings.RAILGATE_API_URL = args[1];
} else {
  const owner = parse(readFileSync(join(root, '.env'), 'utf8'));
  settings = { RAILGATE_API_URL: args[1] ?? owner.RAILGATE_API_URL ?? 'http://127.0.0.1:3000', RAILGATE_AGENT_TOKEN: owner.AGENT_API_TOKEN };
}
settings = ClientSettings.parse(settings);
const text = Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
writeFileSync(path, text, { mode: 0o600 }); chmodSync(path, 0o600);
const launcher = join(root, 'scripts/mcp-launch.mjs');
// Preserve any existing client configuration for owner review.
const codex = join(root, '.codex/config.toml');
const cursor = join(root, '.cursor/mcp.json');
const client = { command: process.execPath, args: [launcher] };
for (const dir of ['.codex', '.cursor']) mkdirSync(join(root, dir), { recursive: true });
if (!existsSync(codex)) writeFileSync(codex, `[mcp_servers.railgate]\ncommand = ${JSON.stringify(client.command)}\nargs = [${JSON.stringify(launcher)}]\n`, { flag: 'wx', mode: 0o600 });
if (!existsSync(cursor)) writeFileSync(cursor, JSON.stringify({ mcpServers: { railgate: client } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Private .env.mcp configured with only the agent credential and API origin.');
console.log('Codex/Cursor project configurations prepared; existing client files were preserved. Restart/reload the client to discover tools.');
console.log('Claude Desktop: add the railgate entry below to your local mcpServers configuration:');
console.log(JSON.stringify({ railgate: client }, null, 2));
