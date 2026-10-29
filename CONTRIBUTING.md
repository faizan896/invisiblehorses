# Contributing

Use Node.js 24 and pnpm 10.20.0. Follow the [local setup](README.md#run-locally).

Before submitting a change, run the checks in the [README](README.md#checks). Changes to worker execution should also pass the worker-runtime tests.

- Test meaningful payment failure cases, concurrency and retries.
- Keep spending and approval decisions deterministic. Agent credentials must not gain owner permissions.
- Use decimal strings or integer minor units for money. Preserve idempotency and reservation history.
- Preserve the testnet chain/token guards and label simulated behavior.
- Keep credentials, private databases and local review artifacts out of Git.

Describe the behavior change and relevant validation in the pull request. Contributions use the [MIT license](LICENSE).
