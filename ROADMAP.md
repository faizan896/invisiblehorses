# Roadmap

railgate stays test-money-only: fixed Base Sepolia USDC (chain 84532), internal test accounts and explicit bank/FX simulations. Owner rules and human approvals remain deterministic; no phase enables an agent to bypass them.

## Phase 1: project presentation and contribution workflow

- [x] Short pitch, demo GIF, compact architecture diagram and three-command offline quickstart.
- [x] Preserve the complete setup, API, security and hosting documentation below the introduction.
- [x] Contribution guide, bug/feature templates and suggested repository topics.
- [x] Publish this roadmap with clear boundaries between current and planned features.

## Phase 2: x402 paid HTTP resources

Goal: fetch a resource, inspect its HTTP 402 requirements, apply owner rules/approval, pay using the verified official x402 `exact` scheme on Base Sepolia, and return the resource plus receipt.

- [x] Verify official x402 documentation/packages before implementing the protocol; report unsupported or unverifiable parts.
- [x] Add `fetch_paid_resource(url, max_price, purpose)` through MCP and a matching authenticated HTTP route, with an explicit idempotency key for payment retries.
- [x] Use server-provided prices, resource-host identity, owner host/category allowlists, per-request caps and daily API spending limits.
- [x] Persist requirements, authorization/payment state, receipt and resource result; never create another payment after an ambiguous response or restart.
- [x] Add a local protected weather/dataset fixture and `pnpm demo:x402`: a $0.01 fetch, an over-limit $5 denial and a retry with no second payment.
- [x] Write protocol/policy tests first, including 402 parsing, official-package headers, idempotency, approvals and denials. Mock external chain calls in tests and label the demo's execution mode.
- [x] Document setup, credentials needed for optional real testnet use, and all limitations.

## Phase 3: standalone payroute package and playground

Goal: extract routing into an independently usable package without dependencies on railgate's server, database or MCP code. The working name is `payroute`; check npm availability before choosing its publish name.

- [ ] Create `packages/payroute` as a pnpm workspace package and switch railgate to it while preserving existing routing behavior/tests.
- [ ] Export a small typed `createRouter({ rails, scoring })` API with `quote(intent)` and `plan(intent)`.
- [ ] Publish the quote/execute/status/reverse adapter interface and ledger, ACH mock, Base Sepolia USDC and Wise sandbox/labelled mock adapters.
- [ ] Support cheapest-by-deadline, fastest, most-certain/refund presets and custom scoring.
- [ ] Add scenarios for US domestic cutoffs/weekends, Monday-night vs Tuesday-morning USD→MXN, refund preference, stablecoin refusal, fee limits, an unhealthy rail and a holiday.
- [ ] Build a static routing playground with intent/time/preferences inputs, quote comparison, a selected route and clear rejection explanations. Use a light background, serif headings and readable cards.
- [ ] Add the package's own README with a short usage example, adapter guide, scenarios and playground link; keep it ready for a later repository split.

Every phase finishes with lint, typecheck, tests, build and credential-free demos passing, followed by a focused commit. Mainnet, real banking and production readiness are outside this roadmap.
