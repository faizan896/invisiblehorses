# Milestone 5: runnable demos and project handoff

The README now documents the finished architecture, a five-minute credential-free workflow, faucet/testnet setup, Claude Desktop/Cursor/Codex MCP configuration, full intents and legacy compatibility, owner policy, accounting, execution, returns and security boundaries. The read-only dashboard includes route explanations alongside the status, decision and audit log. MIT licensing and CI on push/pull request are included; CI targets Node 20, 22 and 24.

`pnpm demo:offline` uses the actual unified router/lifecycle and atomic internal test ledger with an in-memory database and mock notifier. It asserts the $5/$45/$150/idempotency scenario without any external calls. Quote and routing demos remain explicitly hypothetical. The live script waits for asynchronous denial outcomes and preserves its historical idempotency-key format. The recording guide distinguishes testnet, simulated ledger/bank execution, quote-only routing and real phone actions.

The example new-merchant limit is $5.10 of all-in source cost, covering a $5 wallet payment plus modeled $0.03 fees. The owner's agreed $100/payment, $100/day and approval-above-$20 settings remain in force. Fresh live approve-path setup needs at least 55 test USDC and test ETH; no extra live payment was performed during this milestone.

Validation on Node 24: **114 automated tests**, lint, typecheck, build, offline overspend, quote and routing demos passed. The saved cloud installer was rerun successfully with frozen project dependencies and pinned tooling. The running hosted service was verified via anonymous HTTPS health; authenticated owner/API checks and the historical $5 retry were performed locally. Four original live payment records remained, and the paid retry returned the same ID/hash.

Limitations: optional Wise sandbox credentials are absent, so actual sandbox networking is untested; bank/FX/on/off-ramp execution is modeled. The real USDC cooperative-return path is tested through an explicit mock transport, not another live transfer. ntfy API acceptance was observed at M1; native app delivery remains unconfirmed. Remote CI, cloud publication and restoration in a new task are not established by local checks. Local commits have not been pushed.

Automatic approval review rejected transmitting the complete historical payment intent through the public tunnel because of possible sensitive metadata disclosure. That check was completed against the loopback server instead; public checks did not require sending payment metadata.
