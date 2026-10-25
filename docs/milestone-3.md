# Milestone 3 acceptance

Router tests were written before the engine. **77 tests**, lint, type checking, build and the routing demonstration passed on Node 24.

The pure router runs identity/category/expiry/KYB gates before provider calls. Candidate quotes then pass recipient capability/form, corridor, hard USD budgets and existing reservations, amount/liquidity limits, deadline, fees, FX support, health/operating window, reversibility, quote freshness and execution-capability gates before deterministic scoring. The owner chooses lowest cost, fastest, or refund-capability/certainty ranking. No LLM participates.

The identical hypothetical 250,000 MXN bank-form intent routes through modeled USDC on Monday after cutoff and the cheaper mock Wise-style bank rail Tuesday morning. The intent, including its deadline and idempotency key, is unchanged. Neither hypothetical evaluation executes a payment. The corporate demonstration policy is separate from the server's $100 owner policy.

`plan_payment`, `POST /api/routes` and payer-scoped `GET /api/routes/:id` expose the read-only planner. Plans and alternatives are stored in SQLite together with an append-only audit event and policy fingerprint. Quotes may take time: current policy/history are reloaded after the provider call before the final gate/score, covering clock changes, daily rollover and owner edits.

`pnpm demo:routing` runs the comparison. Fixture banking/FX/liquidity/KYB remain explicit test models. The real testnet payment from Milestone 1 is retained; route planning makes no new payment or reservation. Optional Wise sandbox access remains quote-only and is excluded from executable route selection.

Explicit owner routing constraints cannot be bypassed through a new legacy USD-only request lacking counterparty context. Existing paid idempotency keys still return the original payment. The lifecycle milestone will unify the execution entry points.
