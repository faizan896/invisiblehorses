# One real x402 payment on Base Sepolia

This opt-in guide buys `/weather` once for **$0.01 test USDC** from the local fixture using the official x402 facilitator. It was not run as part of repository checks. Use Node 20.19+ and a dedicated test wallet that no other daemon uses. Keep the existing hosted wallet, database and owner policy separate.

1. From the repo root, run `pnpm install --frozen-lockfile && pnpm build`. Create a git-ignored `.env.x402`, replace the placeholders, then run `chmod 600 .env.x402`:

   ```dotenv
   X402_TEST_PRIVATE_KEY=0xREPLACE_WITH_DEDICATED_TEST_WALLET_KEY
   X402_PAY_TO=0xREPLACE_WITH_YOUR_PUBLIC_TEST_RECEIVER_ADDRESS
   BASE_SEPOLIA_RPC_URL=https://base-sepolia-rpc.publicnode.com
   ```

   Fund the payer's public address with at least **0.01 USDC on Base Sepolia** from [Circle's faucet](https://faucet.circle.com/). Select Base Sepolia, chain **84532**. The fixed token is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. This EIP-3009 flow signs an authorization; the facilitator submits the transaction and pays gas. The buyer does not need test ETH for this flow. Never commit the private key or use mainnet funds.

2. Make an isolated owner policy. The existing global caps and approval threshold still apply; these API caps allow exactly one cent per request and per UTC day:

   ```sh
   mkdir -p data
   cp policies/example.yaml data/x402-owner.yaml
   cat >> data/x402-owner.yaml <<'YAML'
   x402:
     max_per_request: "0.01"
     max_per_day: "0.01"
     allowed_hosts:
       - host: "127.0.0.1:4021"
         category: data
     categories: [data]
   YAML
   ```

3. Start the real-settlement merchant in terminal A and leave it running:

   ```sh
   node --env-file=.env.x402 --import tsx examples/x402-server/serve.ts --real
   ```

   This is the `pnpm x402:server --real` entry point with the private environment file loaded. It binds only to `127.0.0.1:4021` and uses `https://x402.org/facilitator`. Facilitator availability, sponsorship and rate limits are external requirements.

4. In terminal B, run this buyer command from the repo root. It uses a separate durable database and a fixed request key. Loopback HTTP is enabled only in this local library harness; the production HTTP/MCP API still requires allowlisted public HTTPS hosts.

   ```sh
   umask 077
   node --env-file=.env.x402 --input-type=module <<'JS'
   import { randomBytes } from 'node:crypto';
   import { setTimeout } from 'node:timers/promises';
   import { Store } from './dist/src/audit/store.js';
   import { loadPolicy } from './dist/src/policy/loader.js';
   import { ApprovalTokens } from './dist/src/approval/tokens.js';
   import { BaseSepoliaExecutor } from './dist/src/rails/usdc-base-sepolia.js';
   import { realX402Protocol } from './dist/src/x402/real.js';
   import { X402Service } from './dist/src/x402/service.js';
   import { configureProxy } from './dist/src/network.js';
   configureProxy();
   const key = process.env.X402_TEST_PRIVATE_KEY, rpc = process.env.BASE_SEPOLIA_RPC_URL;
   const chain = new BaseSepoliaExecutor(rpc, key), store = new Store('data/x402-testnet.sqlite');
   const buyer = new X402Service({
     store, policy: () => loadPolicy('data/x402-owner.yaml'), allowLoopback: true,
     protocol: realX402Protocol(rpc, key), balanceMinor: () => chain.balanceMinor(),
     tokens: new ApprovalTokens(randomBytes(32).toString('hex')),
     notifier: { notify: async () => { throw new Error('No automatic owner approval'); } },
     publicBaseUrl: 'http://127.0.0.1:3000',
   });
   try {
     await buyer.initialize();
     let result = await buyer.request({ url: 'http://127.0.0.1:4021/weather',
       max_price: '0.01', purpose: 'One testnet weather lookup',
       idempotency_key: 'local-weather-once-v1' }, 'x402-test-agent');
     for (let n = 0; n < 12 && ['in_transit', 'settled', 'uncertain'].includes(result.status); n++) {
       await setTimeout(5000); await buyer.tick(); result = await buyer.get(result.id, 'x402-test-agent');
     }
     console.log(JSON.stringify(result, null, 2));
   } finally { store.close(); }
   JS
   ```

   The normal $0.01 request is below the existing approval threshold. If the owner changes policy to require approval, the command stays pending and never approves itself. A completed retry reads the cached result. If confirmation is delayed or delivery is uncertain, preserve the database, wallet, request and key, and keep the merchant running. Rerun the identical command to reuse the original authorization. Do not delete state or change the key to force a replacement purchase.

5. A completed result includes `resource.body` and `receipt.transaction`. Open `https://sepolia.basescan.org/tx/TRANSACTION_HASH`, replacing `TRANSACTION_HASH` with that receipt value. Verify success, the fixed test USDC contract, the payer and `X402_PAY_TO`, and a **0.01 USDC** transfer. Railgate independently requires two L2 confirmations and a transaction matching the persisted authorization nonce before reporting completion. A failed/pending result is not proof of payment; never present a mock hash as explorer evidence.
