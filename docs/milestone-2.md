# Milestone 2 acceptance

Validated on 2026-10-25. **59 tests**, lint, type checking, build, the offline payment demo and quote demo passed on Node 24.

Built the destination-denominated intent, an owner-controlled test counterparty catalog (including Norte Manufacturing in Mexico), a shared `RailAdapter` contract, normalized quotes, the agent-authenticated `/api/quotes` endpoint and `quote_payment` MCP tool.

The quote contract reconciles source principal, fees and steps exactly in integer cents. It includes the recipient's requested amount/currency/form, all-in USD cost, expected/latest usable time, certainty, reversibility, validity and pricing labels. Tests cover validation, owner profile isolation, rail/currency compatibility, fees, US banking holidays/cutoff/DST and the Wise sandbox HTTP contract.

| Rail | What is real versus modeled |
| --- | --- |
| ledger | Free, instant quote between fictional internal test accounts. Execution wiring is deferred to the lifecycle milestone. |
| ach-mock | Explicit simulation of US/USD ACH, including 16:00 New York cutoff and 1–2 US banking-day settlement. It does not directly deliver MXN. |
| usdc-base-sepolia | The existing testnet transfer implementation remains real. New quotes explicitly model onramp, network pricing, FX and offramp; bank-form availability waits for the modeled payout. |
| wise-quote | Clearly labelled mock when no optional sandbox token exists. With token/profile ID, the adapter calls the official `api.wise-sandbox.com/2026Q4` quote endpoint, using inclusive source amounts and `price.total.value.amount`. No Wise transfer/funding endpoint exists. Actual sandbox networking remains untested without credentials. |

The hosted API was restarted and verified with a 250,000 MXN bank-form intent for Norte. It returned two normalized quotes: modeled USDC at 14,740.75 USD all-in and mock Wise-style bank delivery at 14,721.11 USD. These use explicitly fixed model exchange rates, not market rates. The quote request created no payment, reservation or transfer.

After restart, repeating the original live $5 request returned its existing payment/transaction hash without adding a payment row. Existing SQLite payment history and idempotency were preserved. Public HTTPS, authenticated API reads and protected owner access were reverified; the temporary URL is not pinned here.

Run `pnpm demo:quotes`. Multi-rail `execute/status/reverse` calls deliberately fail closed until the lifecycle milestone; only the existing USD-only test USDC payment path is executable at this point. Router eligibility/scoring is the next milestone, with tests written first.
