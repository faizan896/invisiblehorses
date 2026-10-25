# Vercel + Cloudflare Workers Free

The selected free architecture keeps the public Vercel origin and routes its API/dashboard/approval requests to a Cloudflare Worker. One **SQLite-backed Durable Object** owns the database, spending reservations and signer. Durable alarms run the lifecycle only while necessary, including receipt reconciliation, bank availability and approval expiry. No Render service or paid disk is required.

Cloudflare's [current pricing documentation](https://developers.cloudflare.com/durable-objects/platform/pricing/) explicitly supports SQLite Durable Objects on Workers Free: 100,000 requests/day, 5 million rows read/day, 100,000 rows written/day and 5 GB stored data. Free-limit exhaustion fails operations; this workflow never upgrades the plan. These quotas are suitable for the small testnet prototype, not an unlimited production guarantee.

## Prepare and test

Use Node 22+ for the pinned Wrangler/Miniflare tooling; Node 24 is recommended. Node 20.19+ remains supported for the Node CLI and core suite.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build:worker
pnpm test:worker
```

Production uses `wrangler.jsonc` and the `RailgateOwner` class. Test-only `wrangler.test.jsonc` has a separate fake native transport; it must never be deployed. The workerd integration tests use actual durable SQLite storage, explicit mock chain/notification interfaces and no external calls. They cover migration locks, preserved historical IDs/hashes, import checksum and wallet binding, agent/owner separation, ledger execution, durable alarms and eviction after an ambiguous broadcast. Core tests also verify that physical persistence failure prevents any broadcast.

The shared policy/router/lifecycle remain unchanged across Node and Cloudflare. The Node adapter retains `better-sqlite3`. The durable adapter uses the documented [SQL API and synchronous transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/). The native executor explicitly waits for `storage.sync()` before broadcasting signed bytes; preparing a transaction does not move money.

## Account authorization

Create/select a **Workers Free** account. At [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens), use the **Edit Cloudflare Workers** template and restrict account resources to the intended account. Supply `CLOUDFLARE_API_TOKEN` securely to the deployment environment. The operator must inspect the account's plan before deploying and must not subscribe to Workers Paid. Provider credentials are never committed or placed in the worker's application secrets.

Vercel needs only its existing project authorization so the gateway can receive its nonsecret backend origin and be redeployed. The current frontend target is `https://railgate-self.vercel.app`. Keys/passwords belong in secure settings, never a repository or deployment log.

## Move the existing wallet safely

1. Keep the former signer stopped. Confirm there are no pending/reserved/unknown payments. A new wallet must never start with an empty replacement history for the existing idempotency keys.
2. Build and export the original history and backend secrets locally:

   ```sh
   pnpm build
   pnpm export:cloudflare --confirm-daemon-stopped --public-url https://railgate-self.vercel.app
   ```

   This creates ignored mode-0600 `data/hosting/cloudflare-history.json` and `cloudflare-secrets.json`. The history carries exact IDs/fingerprints/hashes, approvals, audit, balances, holds and operations. It is bound to the original payer wallet/agent and checksummed. The separate secrets file contains only application credentials. Neither file belongs on Vercel, in Git or in logs.
3. Inspect the production bundle and deploy only `wrangler.jsonc` to the verified Free account. Upload application secrets with Wrangler's supported secret-bulk command, using the private secrets file. No paid account upgrade is part of these commands. The actor asserts Base Sepolia/fixed USDC before accepting requests.
4. Before import the backend reports `awaiting_history`, stays read-only and refuses payments. Send the private JSON history directly to the verified worker's `POST /owner/bootstrap`, using the original owner bearer credential. Never send it to an unrelated tunnel or project. Import is atomic, refuses existing state and cannot be replayed to replace financial history.
5. Verify `/health` is read-only, owner dashboard/history reads work, and original IDs/transaction hashes/counts match. No spend is needed. Then `POST /owner/activate` with owner authentication and an empty JSON object. Agents cannot access either migration endpoint; the public gateway does not forward them.
6. Set the Vercel project's **production-only** `RAILGATE_BACKEND_ORIGIN` to the actual HTTPS `worker.account.workers.dev` origin, then redeploy its existing production project. Wallet/owner/ntfy keys remain solely on Cloudflare. Verify public health, dashboard 401 without credentials, owner/agent reads, and the original records. There must be only one live signer. Mark the former Node checkout `RAILGATE_READ_ONLY=1` in its private `.env` so an accidental local restart cannot sign against its stale SQLite copy.
7. Point the limited MCP client at Vercel using `pnpm setup:mcp --api-url https://railgate-self.vercel.app`, reload the client and test read-only tools. Do not issue a new payment merely to check deployment.

Persistent state belongs to the existing Durable Object namespace. Preserve the binding/class/migration identity on later deployments. Do not create a replacement namespace and re-import an old snapshot after later payments: that would roll back accounting/idempotency history. No HTTP/API path resets a live database or enables an empty history.

## Idle behavior and limits

The actor schedules only the next required action. It sleeps when idle; there is no interval or keepalive ping to evade platform limits. Pending native transactions retain their original hash/bytes and use a slower poll backoff over time. Bank-form payments wait for the modeled recipient availability, and approvals wake at expiry. At-least-once alarms are safe because the payment/rail operation keys and raw signed transactions remain durable.

All original test-money restrictions apply. USDC transfers use only Base Sepolia; bank/FX/on/off-ramp legs remain simulated, Wise sandbox stays quote-only, owner policy gates remain deterministic and human approvals cannot override hard limits. Publication/build tests do not establish that an account has been authorized or that a live worker has been deployed; verify each step explicitly.
