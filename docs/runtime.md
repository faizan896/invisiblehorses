# CLI and MCP runtime

The repository also includes a guarded testnet runtime for the agent HTTP API, MCP tools and x402 examples. It uses separate configuration and storage from the public workspace.

## Offline examples

```sh
pnpm demo:offline
pnpm demo:quotes
pnpm demo:routing
pnpm demo:x402
```

These examples use mock transports and test data. They require no payment-provider credentials.

## Testnet service

1. Run `pnpm init:local` to create a private, ignored `.env` from `.env.example`. An existing file is preserved.
2. Fund the configured wallet with Base Sepolia test USDC and test ETH if exercising chain transfers. The service checks chain ID 84532 and the fixed Circle test USDC contract; mainnet is refused.
3. Set `PUBLIC_BASE_URL`, the owner policy and counterparty catalog, and the ntfy configuration in the private environment.
4. Run `pnpm dev`, or `pnpm build && pnpm start`. Keep one signer per database/wallet.

The daemon defaults to loopback port 3000. Owner pages `/approvals` and `/dashboard` require Basic username `owner` and `OWNER_API_TOKEN` as password. Agent requests use `AGENT_API_TOKEN`. Policy and recipient configuration live in `policies/` and `examples/counterparties.json`.

Approval links contain single-use capabilities. Do not log their query strings. Preserve payment state across restarts; do not clear reservations, reuse nonces or replace ambiguous transactions with new payments.

## MCP

After building, run `pnpm setup:mcp` to generate ignored local client configuration. To connect manually, launch:

```sh
node /absolute/path/to/railgate/dist/src/cli.js mcp
```

Supply only `RAILGATE_API_URL` and `RAILGATE_AGENT_TOKEN` to that process. It does not load `.env`. Wallet keys, owner credentials and approval secrets stay on the payment backend. Remote API origins require HTTPS; HTTP is limited to loopback.

See [x402 testnet setup](x402-testnet.md) for the paid-resource example.

## Persistent hosting

Cloudflare uses `wrangler.jsonc` and a separate `RailgateOwner` Durable Object. Build and verify with `pnpm build:worker` and `pnpm test:worker`. Never deploy `wrangler.test.jsonc`.

For an existing signer, stop the former daemon before exporting history:

```sh
pnpm build
pnpm export:cloudflare --confirm-daemon-stopped --public-url https://your-runtime.example
```

The command writes private history and application-secret files under ignored `data/hosting/`. Import history through the authenticated backend `/owner/bootstrap` before `/owner/activate`. Bootstrap is one-time and read-only until activation; preserve the namespace thereafter. Keep the former daemon read-only and verify IDs, balances and transaction hashes before switching clients.

The optional `Dockerfile` and `render.yaml` run the Node backend with persistent SQLite storage. Export with `pnpm export:hosting --confirm-daemon-stopped`. Use the generated private configuration only on the backend and preserve its persistent volume.

Set the Vercel gateway's `RAILGATE_BACKEND_ORIGIN` to the deployed runtime origin for these separate runtime endpoints. Workspace requests continue to use the dedicated console gateway.
