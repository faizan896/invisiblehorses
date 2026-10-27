# Overspend demo and recording guide

`pnpm demo:offline` runs the real common lifecycle and deterministic router against an in-memory **test ledger**, a mock notifier and an unused mock chain executor. It asserts $5 completion, $45 approval, a cumulative $150 denial and one debit per idempotent request. No external calls or faucet funds are needed. Keep the simulation labels visible if recording it.

## Record the terminal demo

The README [GIF](../../docs/media/railgate-offline.gif) and [MP4](../../docs/media/railgate-offline.mp4) are generated from the real offline demo, with paced output and persistent simulation labels. The $45 approval is performed by the offline harness, not by a real phone. The blocked request is $100 after $50 spent, totaling $150; it is not a direct $150 request.

On macOS, install [VHS](https://github.com/charmbracelet/vhs) and its dependencies, then run from the repo root:

```sh
brew install vhs ttyd ffmpeg
pnpm install --frozen-lockfile
pnpm demo:record
```

The committed [tape](railgate.tape) uses VHS 0.12.1, ttyd 1.7.7, FFmpeg, Chromium and DejaVu Sans Mono (with Menlo/monospace fallbacks). It writes both files under `docs/media/`. `pnpm demo:offline --present` plays the same presentation without recording. Both modes retain the actual lifecycle, policy and balance assertions. No `.env`, hosted API or notification topic is used by this offline demo.

For the social video, use a 35–45 second recording of an MCP-connected Claude/Cursor/Codex client plus a separate camera shot or screen recording of the owner's phone:

1. Show “Base Sepolia: test money only” and the actual configured limits. Keep keys and private subscription topics out of the frame.
2. Ask the agent for a small test-USDC payment and show its real completed result/hash.
3. Request an amount above the approval threshold only after funding and recipient checks pass. Show the actual phone alert, the human's approval, and the resulting payment status. Verify device subscription/delivery before recording; server publication alone is not proof that the phone received it. Direct notification action support depends on platform; use the owner approval page as needed.
4. Ask for $150 and show the actual policy denial. No dashboard shot is required.

A live filming take creates new payment requests and consumes test funds and daily allowance. Keep request IDs/keys stable during retries, retain the existing authoritative hosted database, and never approve on the human's behalf. Editing may shorten waits; do not turn mock approval or simulated rails into a claim of live behavior.

## Record the testnet demo

For an existing hosted deployment, record the connected agent client using the hosted API. Keep its authoritative database and signer in place; do not start a second local daemon with the same wallet. The local instructions below are for a separate, dedicated test setup.

For a real **Base Sepolia testnet** recording, follow the main README: fund the dedicated payer with at least **55 test USDC** plus test ETH, subscribe to the private ntfy topic, set a reachable HTTPS approval origin and start one `pnpm dev` daemon. Run `pnpm demo` in another terminal. The live script requests wallet delivery, lets the router gate/select it, and waits for the human; it receives no owner token or approval capability from the API.

Keep `DEMO_RUN_ID` unchanged across retries. The original request, including any full-intent deadline and metadata, must stay identical. A different run ID creates new payments and consumes budget. Never reset the database or generate replacement keys to bypass uncertain outcomes or a daily limit.

Suggested 45–60 second clip (record in advance and trim the waiting periods):

1. Show **BASE SEPOLIA / TEST MONEY ONLY** and the owner policy: hard $100/payment, $100/day, approval above $20. New-merchant cap $5.10 covers the first wallet payment's modeled fee allowance.
2. Run `pnpm demo`. Show $5 progressing through the lifecycle and completing with a transaction hash. The recipient receives $5 test USDC; policy accounts for modeled all-in fees too.
3. Show $45 waiting for approval. Crop the phone notification to hide its topic and URL, then tap **Approve** or **Reject**. The owner page `/approvals` is the fallback. An approve take needs enough faucet funds. Use a separate authorized take/day for another outcome; do not alter consumed keys.
4. Show the next $100 request denied. On the approve path this is $150 nominal recipient payments plus fee allowances against a $100 all-in daily budget. On the reject path, $5 plus the new $100 request also exceeds the daily cap. The $100 request's modeled fees also exceed the per-payment ceiling; the explanation lists the failed gates.
5. Show the first retry returning the **same ID and transaction hash**. An owner dashboard shot is optional; the agent result and transaction evidence are enough for the recording.

Optional second clip: `pnpm demo:routing` shows the identical hypothetical 250,000 MXN bank-form intent selecting USDC after Monday cutoff and the cheaper mock bank rail Tuesday morning. Both decisions are read-only plans. This uses a separate fictional corporate policy and fixed test FX; it does not execute a 250,000 MXN payment or change the live $100 limits.

Caption: “Agents request payments. Owner rules and human approvals control spending. The router chooses the rail. Base Sepolia test money only.”

Hide `.env`, passwords, agent/owner credentials, private keys, ntfy topics, approval query strings and developer network panels. Phone action delivery and actual chain transfers are separate checks; see [live acceptance evidence](../../docs/milestone-1.md). The terminal recording is generated by VHS; real phone/agent filming remains a separate capture.
