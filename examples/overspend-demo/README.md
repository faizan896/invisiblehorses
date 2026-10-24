# Overspend demo and short recording guide

`pnpm demo:offline` is a deterministic, clearly labelled simulation with an in-memory database, mock transfers and a recording notifier. It contains assertions and exits nonzero on a broken scenario.

For the real **testnet-only** recording, complete the README setup, start `pnpm dev`, and run `pnpm demo` with a funded test wallet, reachable `PUBLIC_BASE_URL`, and subscribed ntfy app. Keep `DEMO_RUN_ID` unchanged on retries. The live script never knows approval tokens and waits for the owner's phone action.

Suggested 45–60 second clip:

1. Show the terminal heading **BASE SEPOLIA / TEST MONEY ONLY** and the policy ceilings: `$100/payment`, `$100/day`, approval above `$20`.
2. Start `pnpm demo`. Show `$5` completing and its transaction hash.
3. Show `$45` waiting for approval. Record a cropped phone notification; hide the topic and URL. Tap **Approve**. Show the payment complete. Use a separate take on another budget/day to demonstrate **Reject** without changing existing idempotency keys.
4. Show the next `$100` request being denied: `$50` already spent, cumulative attempt `$150` against a `$100` daily limit.
5. Show the retry returning the same payment ID and hash. Open the authenticated read-only dashboard to show the decisions and audit events.

Caption: “Agents request payments. Deterministic owner rules and human approvals control them. Stablecoins are a rail. Base Sepolia test money only.”

Do not show `.env`, owner/agent credentials, private keys, ntfy topics, approval query strings, browser password prompts or developer network panels. If using the offline demo for a clip, keep its **MOCK** labels visible and say it is simulated. No screen recording has been generated automatically.
