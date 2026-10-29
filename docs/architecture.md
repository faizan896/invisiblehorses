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

Pending and queued requests reserve budget. Cancellation before settlement releases the reservation. Completed payments cannot be cancelled. Outstanding reservations carry across UTC midnight. Completed spending counts on the settlement day. Rejected and expired requests release reservations.

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

| Endpoint                       | Permission       | Result                                        |
| ------------------------------ | ---------------- | --------------------------------------------- |
| `POST /v1/payments`            | `payments:write` | Persist a request and return HTTP 202         |
| `GET /v1/payments`             | `payments:read`  | List this agent's payments                    |
| `GET /v1/payments/:id`         | `payments:read`  | Read this agent's payment                     |
| `POST /v1/payments/:id/cancel` | `payments:write` | Cancel a queued or pending request; send `{}` |
| `GET /v1/payments/:id/receipt` | `payments:read`  | Read a completed internal ledger receipt      |

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

Approvals expire after 15 minutes. Workspaces support up to 20 agents, 20 active keys and 200 payment records. Session expiry does not imply data deletion. Audit exports include complete event history and journal entries, excluding secrets and key hashes. SQL triggers prevent ordinary audit updates and deletes; this is not protection against a database administrator.

The public app has no external payouts, billing, team invitations or provider webhooks. The separate [CLI/MCP testnet runtime](runtime.md) uses its own configuration and storage.

## Workspace recovery and agent administration

New workspaces receive a private recovery key once. Only its SHA-256 hash is stored. Owners can replace the key under **Workspace access**; replacement invalidates the old key. The key is a bearer credential and should be saved in a password manager.

`POST /console-api/recover` accepts `{ "code": "ih_recovery.…" }` from the configured origin and sets a new secure owner cookie. Recovery is rate-limited, renews seven-day access, invalidates previous owner sessions, revokes all agent keys and cancels unsettled requests. Saved rules and completed ledger records remain. Recovery keys remain reusable until replaced, allowing a request to be retried after a lost response. There is no email identity or team login service.

Owners can edit agent names and budgets or pause an agent. Paused agents cannot authenticate, and queued work is rechecked before settlement. These changes do not modify the routing engine.

Completed receipts contain the payment and two reconciled journal postings. The receipt explicitly identifies internal test-ledger settlement and sets `external_payment: false`. It is not a bank receipt, provider confirmation or refund operation.
