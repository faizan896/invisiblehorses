# Local x402 merchant

`pnpm demo:x402` runs the complete credential-free buyer/merchant story in process. Official `@x402/core`, `@x402/evm` and `@x402/hono` 2.28.0 construct, sign and verify the protocol. Only facilitator settlement/RPC are mocked. Fake transaction hashes are never presented as on-chain evidence.

`pnpm x402:server` starts a loopback merchant on port 4021: `/weather` costs $0.01 and `/expensive` costs $5. Both use x402 v2 `exact`, `eip155:84532`, Circle test USDC and EIP-3009.

Optional real testnet merchant: `X402_PAY_TO=0xYOUR_TEST_ADDRESS pnpm x402:server --real` uses the official HTTP facilitator at https://x402.org/facilitator. Its availability/rate limits are external. The merchant has no private key. The buyer needs Base Sepolia test USDC; never use mainnet funds. This mode is opt-in and is not run by tests/demo.

For the complete owner policy, wallet funding, local buyer command and explorer verification, follow [one real x402 testnet payment](../../docs/x402-testnet.md). The guide enables loopback only in an isolated buyer harness and uses a dedicated test wallet/database.

The local server's response cache is process-local and disposable. Real merchants must persist their own idempotency/response cache. Railgate persists and replays exactly one signed authorization, so a merchant crash cannot debit its EIP-3009 nonce twice, but an external merchant without response recovery may fail to return content after an ambiguous settlement. Such requests remain reserved/uncertain for owner reconciliation; railgate never buys a replacement automatically.

Production railgate accepts only explicitly owner-allowlisted public HTTPS hosts. Loopback HTTP is available only through the library's explicit fixture constructor option, never an agent request flag. The default demo uses an in-process fetch transport, so it needs neither a port nor network access.

Verified sources: [buyer quickstart](https://docs.x402.org/getting-started/quickstart-for-buyers), [seller quickstart](https://docs.x402.org/getting-started/quickstart-for-sellers), [HTTP transport](https://docs.x402.org/transports/http), [canonical SDK source](https://github.com/x402-foundation/x402/tree/main/typescript). Coinbase's repository now points to the foundation repository.
