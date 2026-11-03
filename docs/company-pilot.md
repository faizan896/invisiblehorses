# Company paid-tool pilot

The tool gate is a separate, self-hosted service for a company whose agents request billable data or tools. It applies company, agent and customer-job budgets before executing an owner-configured provider. It does not hold customer money, issue cards or connect arbitrary vendor API keys.

The public workspace at invisiblehorses.vercel.app still uses internal test credits. Starting this service does not enable real payments in that workspace.

## Run an isolated sandbox

Use Node.js 24, pnpm 10.20.0 and a separate persistent SQLite database. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p data
cp examples/tool-gate/config.sandbox.json data/tool-gate-config.json
export TOOL_GATE_OWNER_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
export TOOL_GATE_CONFIG=data/tool-gate-config.json
export TOOL_GATE_DB=data/tool-gate.sqlite
node dist/src/tool-gate/serve.js
```

The default address is http://127.0.0.1:8410. Override `TOOL_GATE_HOST` and `TOOL_GATE_PORT` only for your own deployment. Put remote access behind HTTPS and your company's access controls. Keep the owner token and provider credentials on the backend. Agents receive only their own agent keys.

The example's `price_minor: 25` is an editable sandbox-fixture setting, not a published vendor price. Sandbox executions and receipts do not represent external purchases. The fixture's in-memory execution history is intentionally lost on restart; an interrupted request remains uncertain rather than being executed again.

## Create an agent and customer job

In a separate trusted owner terminal, use the same private owner token. A company sets these example budget values; they are not fee estimates. All amounts are integer USD cents. Sub-cent prices are unsupported; a supplier must quote a supported fixed-price unit or batch.

```sh
curl http://127.0.0.1:8410/owner/agents \
  -H "Authorization: Bearer $TOOL_GATE_OWNER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"customer_id":"customer-acme","name":"Research agent","per_request_limit_minor":500,"daily_limit_minor":2500}'
```

Save the returned agent `id` and private `key`. The server stores only the key's hash. Replace `AGENT_ID` below with that ID:

```sh
curl http://127.0.0.1:8410/owner/jobs \
  -H "Authorization: Bearer $TOOL_GATE_OWNER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"customer_id":"customer-acme","name":"Supplier research","budget_minor":1000,"agent_ids":["AGENT_ID"],"tool_ids":["data-search"]}'
```

Give the agent its key and the returned job ID. It never needs the owner token or provider credentials.

```sh
export TOOL_GATE_AGENT_KEY=REPLACE_WITH_AGENT_KEY
export TOOL_GATE_JOB_ID=REPLACE_WITH_JOB_ID
export TOOL_GATE_REQUEST_KEY=research-job-001-search-001
node --import tsx examples/tool-gate/client.ts
```

The worker runs independently of request reads and browser tabs. HTTP 202 means the request was saved. Inspect its state before treating it as complete. Reuse the same idempotency key and payload after a transport timeout. A changed payload with that key is rejected.

## Owner and agent endpoints

| Endpoint                           | Access | Purpose                                                |
| ---------------------------------- | ------ | ------------------------------------------------------ |
| `GET /health`                      | Public | Process health only                                    |
| `GET /owner/summary`               | Owner  | Jobs, agents and request summary                       |
| `POST /owner/agents`               | Owner  | Create an agent and return its key once                |
| `PATCH /owner/agents/:id`          | Owner  | Pause an agent or change limits                        |
| `POST /owner/keys/:id/revoke`      | Owner  | Revoke an agent key                                    |
| `POST /owner/jobs`                 | Owner  | Create a customer job and its permissions              |
| `PATCH /owner/jobs/:id`            | Owner  | Change the job budget or active state                  |
| `GET /owner/requests`              | Owner  | Inspect all requests                                   |
| `GET /owner/requests/:id`          | Owner  | Inspect one request                                    |
| `POST /owner/requests/:id/approve` | Owner  | Approve the bound request and quote                    |
| `POST /owner/requests/:id/reject`  | Owner  | Reject a pending approval                              |
| `POST /owner/requests/:id/cancel`  | Owner  | Cancel before execution starts                         |
| `GET /owner/requests/:id/receipt`  | Owner  | Read a confirmed request's receipt                     |
| `POST /v1/requests`                | Agent  | Request a permitted tool for an assigned job           |
| `GET /v1/requests`                 | Agent  | List only this agent's requests                        |
| `GET /v1/requests/:id`             | Agent  | Read only this agent's request                         |
| `POST /v1/requests/:id/cancel`     | Agent  | Cancel this agent's unsettled request before execution |
| `GET /v1/requests/:id/receipt`     | Agent  | Read this agent's confirmed receipt                    |

Send `{}` as the JSON body for approval, rejection, revocation and cancellation. Authorization uses a Bearer token. Owner endpoints never accept an agent key. Agent endpoints never grant owner access. Responses are not cacheable.

## Connect one real provider

The HTTP adapter targets a supplier-controlled integration with three endpoints. An arbitrary search, compute or payment API will not work without an adapter implementing this contract. The supplier must guarantee a fixed or maximum charge tied to its quote. Unbounded usage and estimated costs cannot enforce a hard budget and are unsupported.

Configure an external provider on the company's backend:

```json
{
  "company": {
    "daily_limit_minor": 10000,
    "per_request_limit_minor": 1000,
    "approval_above_minor": 100
  },
  "providers": [
    {
      "id": "data-search",
      "mode": "external",
      "origin": "https://billing.your-data-supplier.example",
      "token_env": "SUPPLIER_TOOL_TOKEN"
    }
  ]
}
```

Set `SUPPLIER_TOOL_TOKEN` to a strong provider-issued bearer token of at least 16 visible ASCII characters in the backend's private environment. The JSON configuration contains only the environment variable's name. Do not expose the provider account or an alternate billing credential to the agent; that would allow it to bypass the gate.

The adapter sends credentials only to the configured HTTPS origin. Redirects and arbitrary agent-supplied hosts are refused. Responses are bounded to 256 KiB. Provider errors and echoed credentials are not forwarded to agents.

### Provider contract

1. `POST /quotes` receives `{ "input": ..., "input_hash": "..." }`. Quotes must be free to request. Return `{ "id": "...", "amount_minor": 25, "currency": "USD", "input_hash": "...", "expires_at": "ISO_TIMESTAMP" }`. The hash is SHA-256 of the canonical JSON input. The amount is a guaranteed maximum charge, not an estimate.
2. `POST /executions` receives `{ "quote_id": "...", "request_id": "...", "input": ... }` and an `Idempotency-Key` header equal to the gate request ID. Persist that identity before billing. A retry must return the original execution and never create another charge.
3. `GET /executions/:request_id` independently reports the outcome. Confirmed outcomes include `state`, `request_id`, `provider_request_id`, `quote_id`, `input_hash`, `currency`, `amount_minor` and an optional `result`. The reference must identify the same execution and actual provider-reported charge. A confirmed state means the tool result and charge are both finalized. A failed state must certify no charge and report `amount_minor: 0`.

The gate checks the provider's status endpoint before confirming a request. A pending response or 404 does not prove failure and does not free the reservation. A cost above the bound, mismatched identity or reused receipt requires investigation; it is not silently accepted.

A provider API confirmation is evidence of what that provider reports. It is not independently verified card, bank or blockchain settlement. A custom bridge's own records are not proof of its upstream vendor bill. Match the provider reference and charge against the actual supplier's billing records before making an external-settlement claim.

## Recover and evaluate a pilot

Keep each provider ID bound to the same supplier and billing account. Use a new provider ID for a replacement and keep the original provider configured until outstanding requests are reconciled. Historical request modes are persisted; changing a sandbox provider to external does not authorize real execution of its queued work.

Run one gate worker per persistent database, preserve its WAL files and back it up using a consistent SQLite backup method. Do not delete uncertain requests or their database to force another purchase. After a crash, execution identities and reservations remain, and the worker attempts status reconciliation instead of creating a replacement charge.

A useful first pilot is one company, one customer workflow and one fixed-price or reliably bounded-cost provider. Require these outcomes:

- Denied requests never reach provider execution.
- Concurrent requests cannot over-reserve a customer-job budget.
- Revoked agents and changed limits stop queued execution.
- Retried requests do not create duplicate provider charges.
- Every confirmed request matches its job, agent, input, quote and provider reference.
- Unknown outcomes retain budget until the supplier reports a trustworthy final state.

This service does not provide team SSO, managed hosting, payment-provider onboarding or universal merchant compatibility. The company owns provider access, integration correctness, persistence and operating controls for its pilot.
