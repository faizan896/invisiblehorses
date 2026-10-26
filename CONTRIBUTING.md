# Contributing to railgate

railgate is an MIT-licensed, test-money-only project. Bug reports, small fixes, adapter work and feedback on payment failure cases are welcome. Read the [README](README.md), [roadmap](ROADMAP.md) and existing tests before proposing changes.

## Set up

Use Node 20.19+, 22.13+ or 24 and pnpm 10.20.0. Worker tooling needs Node 22+; Node 24 is recommended for the complete toolchain.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm demo:offline
pnpm demo:quotes
pnpm demo:routing
```

For changes to the hosted SQLite actor, also run `pnpm build:worker` and `pnpm test:worker`. [The recording guide](examples/overspend-demo/README.md) explains the optional VHS tooling; recording is not needed for ordinary contributions.

## Make a focused change

- Open an issue for a larger design change. Describe the problem, expected behavior and what is real, sandboxed or simulated.
- Write tests first for policy, routing and payment-protocol logic. Exercise meaningful failure cases, concurrency and retries, not only the happy path.
- Keep the six existing MCP tools, HTTP routes and offline demos compatible. Additive tools/routes should use the same owner authorization and accounting boundaries.
- Use decimal strings/integer minor units for money. Preserve idempotency keys, signed payloads and reservation history; an ambiguous outcome is not permission to create another payment.
- Keep policy and approval decisions deterministic. Agents cannot change limits, approve themselves, alter counterparties or bypass a failed gate.
- Keep the fixed Base Sepolia chain/token guards. No mainnet, real bank transfers or unlabelled mock behavior.
- Verify provider/SDK behavior from official documentation or source. Document a missing capability instead of inventing an endpoint.

Run the checks above before opening a PR. Describe the concrete behavior change, validation performed, and relevant limitations. Keep commits small and give them descriptive messages.

## Configuration and test funds

Tests and credential-free demos use synthetic identities, an in-memory/test database and mocked external chain/notification interfaces. Real testnet demos are a separate, explicitly funded workflow: they spend test tokens and may require a human decision. Never approve a real pending request for its owner as part of an automated test.

Keep `.env`, wallet keys, owner/agent credentials, ntfy topics, approval URLs, signed bytes and database snapshots out of Git, issues and recordings. `.env.example` contains placeholders only. Do not reset a live database or run a second signer against its wallet to make a test pass.

## License and community

Contributions are made under the repository's [MIT license](LICENSE). Be specific, constructive and respectful in reviews. Maintainers can use the [suggested GitHub topics](.github/TOPICS.md) to improve discoverability.
