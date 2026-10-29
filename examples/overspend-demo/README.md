# Payment lifecycle examples

Run `pnpm demo:offline` from the repository root. It exercises policy checks, approval, internal test-ledger settlement, denial and idempotent retry without external calls.

For the separately configured Base Sepolia runtime, run `pnpm init:local`, follow the [runtime setup](../../docs/runtime.md), start `pnpm dev` and then run `pnpm demo` in another terminal. The live example waits for the owner's approval or rejection; it does not approve on their behalf. Keep `DEMO_RUN_ID` unchanged when retrying.
