# Architecture and API

## Components

The homepage and workspace are built from `console/` and hosted on Vercel. Requests to `/console-api/*` pass through `src/console/gateway.ts` to the Cloudflare worker defined in `wrangler.console.jsonc`.

Each workspace has a SQLite-backed Durable Object. It stores agents, hashed API keys, owner sessions, spending rules, payments, reservations, ledger entries and audit events. The worker runs queued requests through Durable Object alarms independently of browser polling.

`packages/payroute/` supplies the policy and routing engine. The public workspace executes only the internal test-ledger route. The browser route planner compares modeled alternatives without executing them.

## Payment lifecycle

1. Authenticate a scoped agent key and validate the request.
2. Resolve company and agent rules, then check vendor, payment and daily limits.
3. Atomically reserve budget and persist the request. Requests above the approval threshold wait for an owner decision.
4. Recheck policy at dispatch and post balanced ledger entries in one transaction.
5. Save the final state and append audit events. Repeated requests with the same agent, idempotency key and payload return the original record; changed payloads return HTTP 409.

Pending and queued requests reserve budget. Outstanding reservations carry across UTC midnight. Completed spending counts on the settlement day. Rejected and expired requests release reservations.

## API

Base URL: `https://invisiblehorses.vercel.app/console-api`.

```sh
curl 'https://invisiblehorses.vercel.app/console-api/v1/payments' \
  -H "Authorization: Bearer $INVISIBLE_HORSES_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "idempotency_key": "invoice_001",
    "recipient": "dataco",
    "amount": "12.50",
    "purpose": "Research data invoice"
  }'
```

| Endpoint               | Permission       | Result                                |
| ---------------------- | ---------------- | ------------------------------------- |
| `POST /v1/payments`    | `payments:write` | Persist a request and return HTTP 202 |
| `GET /v1/payments`     | `payments:read`  | List this agent's payments            |
| `GET /v1/payments/:id` | `payments:read`  | Read this agent's payment             |

Amounts are decimal USD strings. Demo recipients are `dataco` and `compute-co`. HTTP 202 acknowledges a saved request; inspect its status to distinguish queued, pending approval, completed and denied outcomes. `completed` means internal test-ledger settlement.

| Status | Meaning                                                     |
| ------ | ----------------------------------------------------------- |
| 400    | Invalid request                                             |
| 401    | Invalid/revoked key or expired session                      |
| 403    | Missing permission or owner origin check failed             |
| 404    | Record not visible to this identity                         |
| 409    | Idempotency conflict, replayed decision or capacity reached |
| 429    | Workspace creation limit reached                            |
| 503    | Service unavailable; retry with the same idempotency key    |

## Access and limits

Owner access uses a seven-day HttpOnly, Secure, SameSite=Strict session cookie. Owner writes require the configured origin. Agent keys use random secrets, persist only SHA-256 hashes, bind to one agent and support immediate revocation. They cannot approve payments or change owner rules.

Demo workspaces start with $10,000 in test credits. Default company limits are $1,000 per payment, $2,500 per day and approval above $50. The initial agent is limited to $100 per payment and $500 per day. These values are editable demo policies.

Approvals expire after 15 minutes. Workspaces support up to 20 agents, 20 active keys and 200 payment records. Session expiry does not imply data deletion. Audit exports exclude secrets and key hashes. SQL triggers prevent ordinary audit updates and deletes; this is not protection against a database administrator.

The public app has no external payouts, billing, team invitations or provider webhooks. The separate [CLI/MCP testnet runtime](runtime.md) uses its own configuration and storage.
