import { serve } from '@hono/node-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config as dotenv } from 'dotenv';
import { z } from 'zod';
import { ConfigSchema } from './config.js';
import { Store } from './audit/store.js';
import { ApprovalTokens } from './approval/tokens.js';
import { NtfyNotifier } from './approval/notifier.js';
import { BaseSepoliaExecutor } from './rails/usdc-base-sepolia.js';
import { loadPolicy } from './policy/loader.js';
import { RailRuntime } from './executor/rail-runtime.js';
import { UnifiedPaymentService } from './executor/unified.js';
import { PaymentService } from './executor/service.js';
import { createApp } from './http/app.js';
import { createMcpServer } from './mcp/server.js';
import type { Hex } from 'viem';
import { configureProxy } from './network.js';
import { QuoteService, defaultAdapters } from './rails/quotes.js';
import { Counterparties } from './counterparty/profiles.js';
import { RoutingService } from './router/service.js';

async function main() {
  const command = process.argv[2];
  if (command === 'mcp') {
    configureProxy();
    // Deliberately do not load .env: this process needs only the limited agent token.
    const cfg = z.object({ RAILGATE_API_URL: z.url().refine((s) => {
      const u = new URL(s); return !u.username && !u.password && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)));
    }), RAILGATE_AGENT_TOKEN: z.string().min(32) }).parse(process.env);
    await createMcpServer(cfg.RAILGATE_API_URL, cfg.RAILGATE_AGENT_TOKEN).connect(new StdioServerTransport());
    return;
  }
  if (command !== 'serve') throw new Error('Usage: railgate serve | mcp');
  dotenv({ quiet: true });
  configureProxy();
  const cfg = ConfigSchema.parse(process.env);
  const policy = () => loadPolicy(cfg.POLICY_PATH); policy();
  const executor = new BaseSepoliaExecutor(cfg.BASE_SEPOLIA_RPC_URL, cfg.RAILGATE_PRIVATE_KEY as Hex);
  // This runs BEFORE opening HTTP or accepting any agent requests.
  await executor.assertTestnet(); await executor.verifyToken();
  const store = new Store(cfg.DATABASE_PATH);
  const legacy = new PaymentService(store, policy, new ApprovalTokens(cfg.APPROVAL_SECRET), new NtfyNotifier(cfg.NTFY_SERVER, cfg.NTFY_TOPIC, cfg.NTFY_TOKEN), executor, cfg.PUBLIC_BASE_URL);
  const profiles = Counterparties.load(cfg.COUNTERPARTY_PATH).withWallets({ [cfg.AGENT_ID]: executor.walletAddress, ...(cfg.DEMO_RECIPIENT_ADDRESS ? { dataco: cfg.DEMO_RECIPIENT_ADDRESS } : {}) });
  const returnExecutor = cfg.DEMO_RECIPIENT_PRIVATE_KEY ? new BaseSepoliaExecutor(cfg.BASE_SEPOLIA_RPC_URL, cfg.DEMO_RECIPIENT_PRIVATE_KEY as Hex) : undefined;
  if (returnExecutor) { await returnExecutor.assertTestnet(); await returnExecutor.verifyToken(); }
  const runtime = new RailRuntime(store, profiles, cfg.AGENT_ID, { executor, address: executor.walletAddress, balanceMinor: () => executor.balanceMinor(), returnExecutor, returnAddress: returnExecutor?.walletAddress });
  const quotes = new QuoteService(profiles, defaultAdapters(cfg.WISE_SANDBOX_TOKEN, cfg.WISE_SANDBOX_PROFILE_ID, runtime));
  const routing = new RoutingService(store, profiles, quotes, policy);
  const service = new UnifiedPaymentService(store, legacy, profiles, routing, runtime, policy, new ApprovalTokens(cfg.APPROVAL_SECRET), new NtfyNotifier(cfg.NTFY_SERVER, cfg.NTFY_TOPIC, cfg.NTFY_TOKEN), cfg.PUBLIC_BASE_URL);
  await service.initialize();
  const app = createApp(service, { ownerToken: cfg.OWNER_API_TOKEN, agentToken: cfg.AGENT_API_TOKEN, agentId: cfg.AGENT_ID }, quotes, routing);
  const server = serve({ fetch: app.fetch, hostname: cfg.HOST, port: cfg.PORT }, () => console.error(`railgate listening on port ${cfg.PORT}; Base Sepolia TEST MONEY ONLY`));
  server.on('error', () => { console.error('Unable to bind HTTP server'); process.exitCode = 1; clearInterval(timer); store.close(); });
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = service.tick().catch(() => { console.error('Payment worker unavailable; funds remain reserved'); }).finally(() => { running = undefined; });
  }, 1000);
  const stop = () => { clearInterval(timer); server.close(() => { void (running ?? Promise.resolve()).finally(() => store.close()); }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
void main().catch((error: unknown) => {
  if (error instanceof z.ZodError) console.error('Configuration invalid. Check required names:', error.issues.map((i) => i.path.join('.')).join(', '));
  else console.error('Startup failed. Check the policy, Base Sepolia RPC, chain ID, and test USDC contract. No payments accepted.');
  process.exitCode = 1;
});
