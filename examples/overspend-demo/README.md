# Overspend demo and recording guide

`pnpm demo:offline` runs the real common lifecycle and deterministic router against an in-memory **test ledger**, a mock notifier and an unused mock chain executor. It asserts $5 completion, $45 approval, a cumulative $150 denial and one debit per idempotent request. No external calls or faucet funds are needed. Keep the simulation labels visible if recording it.

For a real **Base Sepolia testnet** recording, follow the main README: fund the dedicated payer with at least **55 test USDC** plus test ETH, subscribe to the private ntfy topic, set a reachable HTTPS approval origin and start one `pnpm dev` daemon. Run `pnpm demo` in another terminal. The live script requests wallet delivery, lets the router gate/select it, and waits for the human; it receives no owner token or approval capability from the API.

Keep `DEMO_RUN_ID` unchanged across retries. The original request, including any full-intent deadline and metadata, must stay identical. A different run ID creates new payments and consumes budget. Never reset the database or generate replacement keys to bypass uncertain outcomes or a daily limit.

Suggested 45–60 second clip (record in advance and trim the waiting periods):

1. Show **BASE SEPOLIA / TEST MONEY ONLY** and the owner policy: hard $100/payment, $100/day, approval above $20. New-merchant cap $5.10 covers the first wallet payment's modeled fee allowance.
2. Run `pnpm demo`. Show $5 progressing through the lifecycle and completing with a transaction hash. The recipient receives $5 test USDC; policy accounts for modeled all-in fees too.
3. Show $45 waiting for approval. Crop the phone notification to hide its topic and URL, then tap **Approve** or **Reject**. The owner page `/approvals` is the fallback. An approve take needs enough faucet funds. Use a separate authorized take/day for another outcome; do not alter consumed keys.
4. Show the next $100 request denied. On the approve path this is $150 nominal recipient payments plus fee allowances against a $100 all-in daily budget. On the reject path, $5 plus the new $100 request also exceeds the daily cap. The $100 request's modeled fees also exceed the per-payment ceiling; the explanation lists the failed gates.
5. Show the first retry returning the **same ID and transaction hash**. Open the owner-authenticated read-only dashboard and show decisions, route explanations and audit entries.

Optional second clip: `pnpm demo:routing` shows the identical hypothetical 250,000 MXN bank-form intent selecting USDC after Monday cutoff and the cheaper mock bank rail Tuesday morning. Both decisions are read-only plans. This uses a separate fictional corporate policy and fixed test FX; it does not execute a 250,000 MXN payment or change the live $100 limits.

Caption: “Agents request payments. Owner rules and human approvals control spending. The router chooses the rail. Base Sepolia test money only.”

Hide `.env`, passwords, agent/owner credentials, private keys, ntfy topics, approval query strings and developer network panels. Phone action delivery and actual chain transfers are separate checks; see [live acceptance evidence](../../docs/milestone-1.md). No screen recording is generated automatically.
