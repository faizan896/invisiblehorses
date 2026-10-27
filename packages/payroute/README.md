# payroute

**One payment intent. Compare rails by cost, deadline and reversibility, with reasons you can inspect.**

A typed, deterministic routing library extracted from [railgate](https://github.com/faizan896/railgate). Runs in Node 20+ and browsers. No server, database, MCP runtime or LLM dependency. Test money only; this package plans routes and does not move funds by itself.

[Routing playground](https://railgate-self.vercel.app/playground/) · [Playground source](https://github.com/faizan896/railgate/tree/main/packages/payroute/playground) · [Scenario tests](https://github.com/faizan896/railgate/blob/main/packages/payroute/test/scenarios.test.ts) · [MIT license](https://github.com/faizan896/railgate/blob/main/packages/payroute/LICENSE)

The playground runs the library in the browser with fictional profiles and modeled prices. Local preview and independent deployment instructions are below.

## Install and usage

After the maintainer publishes version 0.1.0:

```sh
npm i payroute
```

Save this ten-line, self-contained example as `example.mjs` and run `node example.mjs`. It plans a $10 internal test-ledger payment without keys, external calls or additional fixture files:

```js
import { createRouter, defaultAdapters, Counterparties, PolicySchema, PaymentIntentV2Schema } from 'payroute';
const common = { country: 'US', preferred_currency: 'USD', test_profile: true, categories: ['data'], bank_accounts: [], stablecoin_wallets: [], kyb_status: 'verified', payment_preferences: ['internal'] };
const profiles = new Counterparties(['payer', 'merchant'].map(id => ({ ...common, id, name: id, internal_account: `test:${id}` })));
const now = new Date(), deadline = new Date(now.getTime() + 86400000).toISOString();
const policy = PolicySchema.parse({ max_per_payment: '100', max_per_day: '100', new_merchant_max: '100', require_approval_above: '20', expires_at: deadline, allowed_merchants: [{ id: 'merchant' }] });
const context = i => ({ payer: profiles.get(i.payer), recipient: profiles.get(i.recipient), policy, history: { now: now.toISOString(), spent_today: '0', paid_merchants: [] } });
const router = createRouter({ rails: defaultAdapters(), scoring: 'cheapest-by-deadline', context });
const intent = PaymentIntentV2Schema.parse({ payer: 'payer', recipient: 'merchant', amount: '10', destination_currency: 'USD', deadline, purpose: 'invoice', idempotency_key: 'invoice-1', max_fee: '1', reversibility_requirement: 'none' });
console.log(await router.quote(intent));
console.log(await router.plan(intent));
```

Before publication, the monorepo resolves `payroute` as a workspace dependency. To try the package elsewhere, run `pnpm build && npm pack` in `packages/payroute`, then install the generated tarball. The npm archive contains only compiled `dist` files, this README, the MIT license and required package metadata. Source tests, example fixtures and environment files are excluded.

`context` is trusted **application/owner configuration**, separate from the intent: provide real spent/reserved history and owner-maintained counterparty profiles. The zero-spend history above is only an isolated example. An agent must never supply policy, KYB state, allowlists or spending history. The router resolves this context again after asynchronous quoting to catch policy edits and budget changes; the application must still reserve atomically immediately before execution.

`quote(intent)` returns normalized quotes from matching adapters. `plan(intent)` applies hard owner, capability, deadline, health, liquidity and fee gates before scoring, and returns `{ selected, decision, reasons, explanation, alternatives }`. Each alternative has `eligible`, `reasons`, its quote (or `null` if unavailable), and policy evaluation. `needs_approval` is a plan result, never permission to execute. Latest **recipient availability**, including payout legs, must meet the deadline.

## Scoring

| Preset | Order after hard gates |
| --- | --- |
| `cheapest-by-deadline` | All-in USD cost, expected availability, certainty |
| `fastest` | Expected availability, cost, certainty |
| `most-certain` | Reversibility, certainty, cost, availability (refund preference) |
| `(quote) => number` | Custom score; lower wins, ties use rail ID |

Custom scores must be finite. The function receives an isolated quote copy and cannot change the selected payment's amount or make an ineligible route eligible. Scoring never bypasses a hard gate or owner approval.

## Adapters

| Built-in | Quote model | Execution |
| --- | --- | --- |
| `LedgerAdapter` | Instant, free internal test account route | Requires your guarded backend |
| `AchMockAdapter` | Simulated US/USD, 16:00 New York cutoff, US banking calendar | Requires your simulated backend |
| `UsdcQuoteAdapter` | Base Sepolia USDC; modeled fees/onramp/FX/offramp | Requires a backend enforcing chain 84532 and fixed test USDC |
| `WiseMockQuoteAdapter` | Explicit mock Wise-style price/bank delivery | Requires your simulated backend |
| `WiseSandboxQuoteAdapter` | Existing verified Wise sandbox quote API | Quotes only, excluded from executable plans |

`defaultAdapters()` uses all four credential-free models. None contacts a blockchain or bank. `wiseAdapter(token, profileId)` opts into sandbox quotes only; keep that token on a server, never the static playground. Actual USDC settlement belongs to railgate's guarded runtime, not this library. No mainnet execution backend is provided.

Implement the exported interface to add a rail:

```ts
interface RailAdapter {
  readonly id: string; // lowercase letter, then letters/numbers/hyphens, max 80
  quote(context: QuoteContext): Promise<RouteQuote | null>;
  execute(key: string, context: QuoteContext, quote: RouteQuote): Promise<RailExecution>;
  status(id: string): Promise<RailExecution>;
  reverse(id: string): Promise<RailExecution>;
}
```

Return `null` for unsupported corridors. Use `RouteQuoteSchema.parse` or `modeledQuote` to reconcile principal, fee breakdown, step fees and all-in USD cost exactly. Amounts are decimal strings; calculations use integer cents. Quote IDs must be UUIDs; the quote's rail must match the adapter ID. Set `pricing`, `execution`, availability bounds, health, liquidity, reversibility and simulated step labels honestly. Register the custom rail ID in the **owner's** `routing.allowed_rails`; adding an adapter alone does not authorize it.

For a quote model, extend `QuoteOnlyAdapter` and implement `id` and `quote`. Its other three methods fail closed without an injected `RailExecutionBackend`. A backend owns durable idempotency, balance reservations, owner approvals, chain checks, nonce persistence, settlement reconciliation and reversal safety. The router never calls `execute`, `status` or `reverse` during planning. In-flight retries and approvals therefore remain the host application's responsibility; this package makes no standalone exactly-once execution claim.

The adapters and profiles are intentionally test-only (`test_money_only`, `test_profile`, chain 84532). Real KYB, bank integrations and production transfers are outside this release. The calendar models US holidays and New York/DST cutoffs; MX/EU banking holidays and live liquidity/rates are not modeled.

## Scenarios

`pnpm test` runs without keys or network access:

- US domestic ACH before/after cutoff, weekend closure and Thanksgiving.
- A custom **mock RTP adapter** demonstrates a 24/7 domestic alternative on weekends. No RTP bank API is invented or called.
- The identical USD→250,000 MXN intent chooses test USDC Monday night, mock bank Tuesday morning.
- Refunds prefer reversibility; a hard reversibility requirement remains a hard gate.
- A recipient refuses stablecoins, or all-in fees exceed `max_fee`.
- Unhealthy rails are rejected before any custom score runs.
- Custom scoring, normalized quotes and execution refusal without a backend.

Railgate's pre-existing routing, quote and lifecycle tests also exercise this extracted library **unchanged** through compatibility exports. Its server/database wrappers remain in the railgate application.

## Playground and development

From this directory: `pnpm install`, `pnpm build`, `pnpm test`, `pnpm dev`. In this monorepo run `pnpm dev:playground` at the root. The page runs the actual library in the browser with fictional profiles, modeled pricing and no external API requests. It never signs, pays or approves anything.

`pnpm build:playground` generates `playground/dist` (static HTML/CSS/JS). The repository includes [Vercel](https://github.com/faizan896/railgate/blob/main/packages/payroute/vercel.json) and [Netlify](https://github.com/faizan896/railgate/blob/main/packages/payroute/netlify.toml) configs: set the project/base directory to `packages/payroute` in the monorepo, or the package root after moving it into its own repository. Build command `pnpm build:playground`, publish/output directory `playground/dist`. No secrets or backend needed. The monorepo's root build additionally stages this output at `/playground/` beside railgate's existing API gateway.

To split out the project, copy this directory from GitHub as a new repository, install its declared dependencies, then run `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm build:playground`. Source imports stay inside this package. Examples, tests and deployment configuration live in Git, outside the npm archive. The development toolchain needs Node 20.19+; the compiled library supports Node 20+.

## Name availability

On **2026-10-27**, the public npm registry returned 404 for `payroute`. The name appears unused publicly at that check; a 404 does not reserve it or guarantee npm will allow registration. Version 0.1.0 is prepared for publication. Nothing has been published by this change.

## Publish

From the repository root:

```sh
cd packages/payroute
npm login
npm publish --access public
```

The `prepublishOnly` hook builds the ESM output and runs the scenario tests before npm publishes. The package metadata sets public access and the npm registry explicitly.
