# Deployment

The app uses Vercel for static pages and the API gateway, and Cloudflare Workers with SQLite Durable Objects for persistent workspace state and background processing.

## Workspace backend

Review `wrangler.console.jsonc` for the intended Cloudflare account and exact `PUBLIC_ORIGIN`. Changing the domain also requires updating this origin so owner actions pass the CSRF check.

With Cloudflare credentials configured in the deployment environment:

```sh
pnpm build:console-worker
pnpm test:console-worker
pnpm deploy:console-worker
```

Preserve the worker name, Durable Object bindings and migration history when updating an existing deployment. Do not replace its namespace or restore an older snapshot over newer payment records.

The Vercel gateway's workspace backend URL is in `src/console/gateway.ts`. Update it only when moving the backend.

## Frontend

Import the repository into Vercel using the repository root. `vercel.json` defines the build command, output directory and routes. The build stages:

- `console/landing.html` as the homepage.
- `console/dist/` under `/app/`.
- The routing playground under `/playground/`.

The current production domain is `invisiblehorses.vercel.app`. The former `railgate-self.vercel.app` hostname redirects to it. Session cookies are scoped to a hostname; changing domains does not carry over browser owner sessions.

After deployment, check the homepage, `/app/`, `/playground/` and `/console-api/health`. Create a demo workspace, issue a scoped key, submit a request, approve a request above the threshold and confirm background settlement with the tab closed.

## Configuration and state

The workspace worker uses internal test credits and does not require a bank key, signing wallet or model-provider key. Keep provider credentials and local databases out of the static output and repository. Review account quotas, logging and backup requirements for the intended usage.

The separate CLI/testnet backend uses `wrangler.jsonc` or the optional Docker/Render configuration. It is independent of the workspace worker. See [runtime configuration](runtime.md).
