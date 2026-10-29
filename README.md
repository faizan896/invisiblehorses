# Invisible Horses

Payment controls for software agents. Give each agent a scoped key, set spending limits, approve requests and track payments processed in the background.

[Open the app](https://invisiblehorses.vercel.app/app/) · [Route planner](https://invisiblehorses.vercel.app/playground/)

The public app uses internal test credits. External bank and crypto payments are not connected.

## Run locally

Use Node.js 24 and pnpm 10.20.0.

```sh
pnpm install --frozen-lockfile
pnpm --filter payroute build
```

Start the backend and frontend in separate terminals:

```sh
pnpm dev:console-worker
```

```sh
pnpm dev:console
```

Open **http://127.0.0.1:8788/app/**. Local development needs no payment-provider credentials. To run the route planner separately, use `pnpm dev:playground`.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm build:console
pnpm build:playground
pnpm test:worker
pnpm test:console-worker
```

## Structure

| Path                                         | Purpose                                                     |
| -------------------------------------------- | ----------------------------------------------------------- |
| `console/`                                   | Homepage and workspace UI                                   |
| `src/console/`                               | Workspace API, permissions, approvals and background ledger |
| `packages/payroute/`                         | Routing engine and route planner                            |
| `api/`                                       | Vercel API gateway                                          |
| `public/`                                    | Assets used by the app                                      |
| `test/`, `cloudflare-test/`, `console-test/` | Application and worker tests                                |
| `scripts/`                                   | Build, development and deployment tooling                   |

## Documentation

- [Architecture and API](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Route planner data sources](docs/payroute-numbers-audit.md)
- [CLI and MCP runtime](docs/runtime.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
