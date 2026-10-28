# Railgate: an agent payments control plane

[Open the working product](https://railgate-self.vercel.app/app/) · [Routing playground](https://railgate-self.vercel.app/playground/)

[Watch the 51-second product walkthrough](https://railgate-self.vercel.app/railgate-walkthrough.mp4). Captured from the deployed app, with readable captions and the private API key hidden. Shows workspace creation, scoped access, spending rules, a $75 approval, background settlement and the audit record. Internal test credits only.

Railgate turns an agent's payment request into an owner-controlled workflow: authenticate a scoped key, check company and agent budgets, reserve spending capacity, collect approval when necessary, settle accepted work in a durable internal ledger, and keep an append-only record.

The public release is a working demo with internal USD test credits. It does not connect to customers' bank accounts, move production crypto, or claim to be a licensed payment processor. The infrastructure and controls execute on the server; dashboard records are not hardcoded examples.

## Try it in two minutes

1. Open the app and create a private workspace. Each visitor gets separate durable storage, $10,000 in internal test credits, and a seven-day owner session.
2. Open **Agents & keys** and issue a test API key. The initial Procurement agent is limited to $100 per payment and $500 per day. Copy the key once; the server stores only its SHA-256 hash.
3. Open **Developers**. Try a $12.50 request, a $75 approval, and a $150 limit check under the default rules. These are real HTTP requests, not animations. Edited rules can produce different outcomes.
4. Approve the $75 request in **Approvals**. Agents cannot approve it themselves.
5. Close the browser tab after submitting an allowed request. The server's durable alarm still runs. Return to **Payments** to inspect its persisted outcome.
6. Reuse an idempotency key with the same payload to get the original payment. A changed payload returns HTTP 409.
7. Inspect the event history, revoke a key, change spending rules, or export the workspace audit as JSON.

Default company settings are $1,000 per payment, $2,500 per UTC day, and human approval above $50. These are editable demo policies, not market prices. Outstanding reservations carry across midnight; completed spending is counted on its settlement day.

## What is implemented

| Capability | Implementation |
| --- | --- |
| Private workspaces | One Cloudflare SQLite-backed Durable Object per workspace, selected by an unguessable UUID |
| Owner access | Random 256-bit session secret; hash persisted; HttpOnly, Secure, SameSite=Strict cookie; seven-day expiry |
| Agent keys | Random 256-bit secrets; stored as SHA-256 hashes; single display; read/write scopes; immediate revocation |
| Agent isolation | Keys bind to one agent; list/detail endpoints cannot read another agent's payments |
| Policies | Existing payroute policy and routing engine; company limits, agent limits, approved vendors, approval threshold |
| Atomic reservations | Fresh policy evaluation and reservation insertion in one synchronous SQLite transaction |
| Idempotency | Unique `(agent_id, idempotency_key)` constraint and canonical payload fingerprint; conflict on changed payload |
| Approval queue | Owner-only decisions; CSRF origin check; 15-minute expiry; policy recheck on approval |
| Background processing | Durable Object alarms; no dependency on browser reads, polling, local intervals or open tabs |
| Settlement | Policy recheck at dispatch; balanced debit and credit entries plus final state committed in one transaction |
| Crash/retry behavior | Roll back failed settlements; idempotent alarm replay; durable recovery after runtime restart |
| Audit | Append-only SQLite events; SQL triggers prevent UPDATE/DELETE; export excludes secrets and hashes |
| Providers | Internal test ledger available; external bank payouts and USDC transfers explicitly marked not connected |
| UI | Overview, payments, approvals, agents/keys, rules, developer examples, activity; responsive light/dark themes |

No configured wallet keys, owner tokens, or legacy payment database are copied into this product's worker. It deploys separately from the existing `railgate-backend` service. The original testnet runtime and routing playground remain available.

## Architecture

```text
Browser owner session                   External agent / script
        |                                        |
        | HttpOnly cookie                        | scoped Bearer key
        v                                        v
Vercel static console + /console-api/* gateway
        |
        | narrowly allowed endpoints, no caching
        v
Cloudflare railgate-console worker
        |
        +-- creation limiter, with hashed visitor IPs
        |
        +-- workspace UUID --> isolated SQLite Durable Object
                                |
                                +-- keys, agents, rules
                                +-- payments + atomic reservations
                                +-- append-only audit
                                +-- durable alarm
                                      |
                                      +-- fresh policy check
                                      +-- atomic balanced ledger settlement
```

The Vercel function is stateless. It forwards only the console session cookie and relevant request headers to the dedicated backend. It does not store SQLite in an ephemeral function filesystem. The existing authenticated `/api/*`, `/dashboard`, MCP and testnet backend paths keep their previous behavior.

The landing page is built from `console/landing.html`, and the app from `console/`. The data/API implementation lives in `src/console/`. The separate worker configuration is `wrangler.console.jsonc`. The original router and policy engine in `packages/payroute/src/` are reused without modification. The MCP command now lazily loads server-only dependencies, and its shared request schema lives independently of the payment runtime. This fixes slow connector startup without relaxing its existing integration test timeout.

## API contract

Base URL: `https://railgate-self.vercel.app/console-api`

```sh
export RAILGATE_API_KEY='your_test_key'

curl 'https://railgate-self.vercel.app/console-api/v1/payments' \
  -H "Authorization: Bearer $RAILGATE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "idempotency_key": "invoice_001",
    "recipient": "dataco",
    "amount": "12.50",
    "purpose": "Research data invoice"
  }'
```

`POST /v1/payments` requires `payments:write`. It returns HTTP 202 and a saved record. A business policy denial returns a record with `status: "denied"`; HTTP 202 is not a settlement receipt. `GET /v1/payments` and `GET /v1/payments/:id` require `payments:read` and are restricted to the authenticated agent.

Recipients in this demo are `dataco` and `compute-co`. Amounts are positive decimal strings in USD. The route is the internal test ledger. `completed` means the two internal journal postings and final payment state have committed; no external transfer is implied.

| HTTP status | Meaning |
| --- | --- |
| 400 | Invalid schema or amount |
| 401 | Invalid/revoked key or expired workspace |
| 403 | Missing key scope or owner origin check failed |
| 404 | Resource not visible to this identity |
| 409 | Idempotency conflict, replayed decision, or demo capacity reached |
| 429 | Anonymous workspace creation limit reached |
| 503 | Service unavailable; retry an uncertain request with the same idempotency key |

A payment request accepts no caller-supplied agent identity, approval state, account balance, route quote, or owner policy. Amounts are normalized to integer cents before checks. Keys have no owner capability.

## Local development

```sh
pnpm install --frozen-lockfile
pnpm --filter payroute build

# Terminal 1: isolated worker with durable local SQLite
pnpm dev:console-worker

# Terminal 2: app, with a same-origin API proxy
pnpm dev:console
# Open http://127.0.0.1:8788/app/
```

The console development command disables dotenv credential loading. It does not require a wallet, OpenAI key, bank provider or existing payment backend. Local storage is managed by Wrangler under its ignored state directory. Production creation/owner actions require the configured `PUBLIC_ORIGIN`; development uses a localhost override.

Build the static product with `pnpm build:console`. Build or deploy only the new worker with `pnpm build:console-worker` / `pnpm deploy:console-worker`. Its account and public origin are explicit in `wrangler.console.jsonc`. Vercel's existing Git integration builds the landing page, console and playground on push.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm build:playground
pnpm build:console
pnpm test:worker
pnpm test:console-worker
```

The new tests cover scoped/revoked keys, owner/agent separation, cross-agent reads, CSRF, concurrent reservations across agents, idempotency conflicts, policy changes before dispatch, approval expiry/replay, atomic journal rollback, UTC rollover, durable alarms without reads, and SQLite persistence across runtime restarts.

The browser walkthrough creates a workspace and key, submits an actual API request, closes the only page, waits for settlement without reads, reopens the app, approves another request, checks a denied request, and exercises every view and theme at desktop/mobile sizes.

Release verification: 205 automated tests passed: 180 root tests, 12 payroute tests, 11 existing worker-runtime tests, and 2 new console-runtime tests. Typecheck, lint, application build and both static frontend builds passed. The original five-second MCP startup test passes after removing server-only imports from connector startup.

## Production walkthrough and screenshots

The deployed product was verified end to end at https://railgate-self.vercel.app/. The browser created a private workspace and scoped key, submitted a payment through the actual dashboard form, closed the only tab, and verified that the durable worker completed it without polling. The walkthrough also verified owner approval, a blocked payment, idempotent replay, an audit export without the raw API key, all seven app views, a separate browser's isolated onboarding, and the preserved routing playground. No uncaught JavaScript errors or page-level horizontal overflow were observed.

The dedicated production backend also passed an independent API check for background settlement, replay safety and immediate key revocation. Its worker version at release was `31ff6649-5d84-444c-a072-464f37890c2d`; the frontend application commit was `eae18ae`.

All screenshots below were captured from production with real records created by the verification walkthrough. API keys and session cookies are not shown.

| Screen | Light | Dark |
| --- | --- | --- |
| Desktop workspace | [View](agent-payments-screenshots/desktop-light.png) | [View](agent-payments-screenshots/desktop-dark.png) |
| Mobile workspace | [View](agent-payments-screenshots/mobile-light.png) | [View](agent-payments-screenshots/mobile-dark.png) |

[Product page, desktop](agent-payments-screenshots/product-desktop.png) · [Product page, mobile](agent-payments-screenshots/product-mobile.png) · [Actual approval queue](agent-payments-screenshots/approval-queue.png)

## Portfolio description you can use

> Built Railgate, an agent payments control plane with scoped API keys, deterministic spending policies, owner approvals, atomic budget reservations and durable background processing. Implemented isolated SQLite workspaces on Cloudflare Durable Objects, a responsive Vercel-hosted dashboard, and idempotent internal ledger settlement with an append-only audit trail. Shipped a working public test-credit demo and an independently sourced routing playground.

## Before accepting real customer money

A funded production release needs an actual provider contract and verified integration, company onboarding and authentication, account ownership verification, signed provider webhook handling, external settlement reconciliation, incident and reconciliation tooling, appropriate compliance/legal review, and an explicit custody model. External payment retries need provider idempotency and reconciliation of ambiguous outcomes; the internal transaction guarantee must not be advertised as an external funds guarantee.

This public workspace is deliberately bounded: seven-day sessions, 20 agents, 20 active keys and 200 payment records per workspace. Anonymous creation is rate-limited. Workspace access expiry is not a promise of automatic data deletion. Demo users should not enter sensitive business information. There are no bank payouts, billing subscriptions, email invitations or outbound webhooks disguised as implemented features.
