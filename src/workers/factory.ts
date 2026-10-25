import type { Hex } from 'viem';
import { parse } from 'yaml';
import { ConfigSchema } from '../config.js';
import { PolicySchema } from '../policy/schema.js';
import { Counterparties } from '../counterparty/profiles.js';
import { StoreCore } from '../audit/store-core.js';
import { ApprovalTokens } from '../approval/tokens.js';
import { NtfyNotifier, type Notifier } from '../approval/notifier.js';
import { BaseSepoliaExecutor } from '../rails/usdc-base-sepolia.js';
import type { TestnetExecutor } from '../rails/testnet.js';
import { PaymentService } from '../executor/service.js';
import { UnifiedPaymentService } from '../executor/unified.js';
import { RailRuntime } from '../executor/rail-runtime.js';
import { QuoteService, defaultAdapters } from '../rails/quotes.js';
import { RoutingService } from '../router/service.js';
import type { DurableStorage } from './sqlite.js';

export type Native = { executor: TestnetExecutor; address: Hex; balanceMinor: () => Promise<number>; returnExecutor?: TestnetExecutor; returnAddress?: Hex };
export function durableExecutor(executor: TestnetExecutor, storage: DurableStorage): TestnetExecutor {
  return { assertTestnet: () => executor.assertTestnet(), prepare: (intent) => executor.prepare(intent), receipt: (hash) => executor.receipt(hash), broadcast: async (raw) => {
    // SQL execution is synchronous, but physical persistence is asynchronous. Flush BEFORE outflow.
    await storage.sync(); return executor.broadcast(raw);
  } };
}
export async function realNative(cfg: ReturnType<typeof ConfigSchema.parse>): Promise<Native> {
  const executor = new BaseSepoliaExecutor(cfg.BASE_SEPOLIA_RPC_URL, cfg.RAILGATE_PRIVATE_KEY as Hex);
  await executor.assertTestnet(); await executor.verifyToken();
  const returning = cfg.DEMO_RECIPIENT_PRIVATE_KEY ? new BaseSepoliaExecutor(cfg.BASE_SEPOLIA_RPC_URL, cfg.DEMO_RECIPIENT_PRIVATE_KEY as Hex) : undefined;
  if (returning) { await returning.assertTestnet(); await returning.verifyToken(); }
  return { executor, address: executor.walletAddress, balanceMinor: () => executor.balanceMinor(), returnExecutor: returning, returnAddress: returning?.walletAddress };
}
export async function createDurableService(store: StoreCore, storage: DurableStorage, cfg: ReturnType<typeof ConfigSchema.parse>, catalog: unknown, policyYaml: string, native: Native, notifier?: Notifier, clock = () => new Date()) {
  const policyValue = PolicySchema.parse(parse(policyYaml)); const policy = () => policyValue;
  const profiles = new Counterparties(catalog).withWallets({ [cfg.AGENT_ID]: native.address, ...(cfg.DEMO_RECIPIENT_ADDRESS ? { dataco: cfg.DEMO_RECIPIENT_ADDRESS } : {}) });
  const tokens = new ApprovalTokens(cfg.APPROVAL_SECRET), channel = notifier ?? new NtfyNotifier(cfg.NTFY_SERVER, cfg.NTFY_TOPIC, cfg.NTFY_TOKEN);
  const guarded = { ...native, executor: durableExecutor(native.executor, storage), returnExecutor: native.returnExecutor ? durableExecutor(native.returnExecutor, storage) : undefined };
  const legacy = new PaymentService(store, policy, tokens, channel, guarded.executor, cfg.PUBLIC_BASE_URL, clock);
  const runtime = new RailRuntime(store, profiles, cfg.AGENT_ID, guarded, clock);
  const quotes = new QuoteService(profiles, defaultAdapters(cfg.WISE_SANDBOX_TOKEN, cfg.WISE_SANDBOX_PROFILE_ID, runtime), clock);
  const routing = new RoutingService(store, profiles, quotes, policy, clock);
  const service = new UnifiedPaymentService(store, legacy, profiles, routing, runtime, policy, tokens, channel, cfg.PUBLIC_BASE_URL, clock);
  await service.initialize();
  return { service, quotes, routing };
}
