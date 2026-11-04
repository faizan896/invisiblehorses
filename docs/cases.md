# Cases workbench

Cases groups imported charge and result records by customer and job. It highlights missing evidence, unknown charges, pending refunds, open reservations and amount mismatches.

This is read-only analysis. It does not contact providers, execute purchases, issue refunds, release reservations or change payment rules. Imported records are not independently verified provider or bank evidence.

## Storage

The app uses the authenticated workspace Cases API when available. If the initial GET returns 404, it uses workspace-scoped IndexedDB and displays **Saved in this browser**. Browser records stay in that browser profile and are not shared across devices. This is not an encrypted vault.

Existing browser records remain on the device if the workspace API is enabled later. They are not silently hidden, uploaded or merged into server records.

Authentication and server errors do not silently switch storage. Export your records before clearing browser data.

The browser extracts allowed facts from provider JSON before any API transmission. Document bodies, unrelated metadata and credentials are discarded. Direct API imports are normalized before persistence too. Never put credentials or personal content in identifiers.

## Import and export

Choose **Import records** and paste JSON or select a UTF-8 JSON file, up to 1 MiB. A workspace supports 1,000 events and 200 operations. Normalized imports support 1,000 events; provider imports support 100 source records.

Imports are atomic. Reusing an event ID with identical facts is a no-op; changing its facts is a conflict. An operation must keep the same customer, job, provider, provider reference, unit and source.

**Export records** produces a normalized JSON envelope that can be reimported. Stored source labels and import timestamps are not exported as trusted evidence. Restoring records into another workspace marks them as unverified imports.

**Load demo cases** adds deterministic synthetic examples only when clicked. Repeating it does not create duplicates. It does not affect payment balances.

### Normalized format

Amounts below are example input values, not vendor prices. In usd_cent, 125 means USD 1.25. In credit, 125 means 125 provider credits. Units are never combined or converted.

```json
{
  "format": "normalized",
  "events": [
    {
      "event_id": "example-charge",
      "operation_id": "operation-1",
      "job_id": "research-job-1",
      "customer_id": "customer-1",
      "provider": "custom",
      "provider_ref": "supplier-request-1",
      "unit": "usd_cent",
      "kind": "charge_reported",
      "amount_minor": 125,
      "occurred_at": "2026-11-04T09:00:00Z"
    }
  ]
}
```

Providers: stripe, firecrawl, custom. Units: usd_cent, credit. Identifiers use letters, numbers, underscores, periods, colons or hyphens, at most 120 characters. Times must include a time zone.

Events requiring amount_minor: bound_set, reservation_opened, charge_reported, refund_reported. Charge and refund amounts are cumulative totals for the operation, not increments.

Events without amounts: reservation_released, no_charge_reported, refund_requested, execution_started, execution_completed, execution_failed, result_delivered, result_failed.

A later higher bound does not erase a charge that exceeded its bound at charge time. A refund request is not a completed refund. A reported result does not establish usefulness, correctness or licensing rights.

### Stripe JSON events

Use format=stripe and a records array of charge.succeeded, charge.captured, charge.failed or charge.refunded JSON events. Charge imports require USD, explicit paid/captured flags and amount_captured. Uncaptured authorizations are not captured charges.

Each charge needs job_id, customer_id and operation_id in metadata. Alternatively, wrap an existing event as:

```json
{
  "format": "stripe",
  "records": [
    {
      "context": {
        "job_id": "research-job-1",
        "customer_id": "customer-1",
        "operation_id": "operation-1"
      },
      "response": {
        "id": "evt_example",
        "type": "charge.succeeded",
        "created": 1793782800,
        "data": {
          "object": {
            "id": "ch_example",
            "currency": "usd",
            "paid": true,
            "captured": true,
            "amount_captured": 125,
            "metadata": {}
          }
        }
      }
    }
  ]
}
```

If metadata and manual context both exist, they must agree. Refunds require explicit successful refund evidence before being recorded as refunded. Pending or incomplete evidence remains unconfirmed; partial refunds stay partial.

Stripe file imports do not validate webhook signatures. A charge does not establish delivery. Import separate delivery facts from application records when available.

### Firecrawl JSON status records

Use format=firecrawl and wrap saved crawl status responses with context and observed_at:

```json
{
  "format": "firecrawl",
  "records": [
    {
      "context": {
        "job_id": "research-job-2",
        "customer_id": "customer-1",
        "operation_id": "operation-2"
      },
      "provider_ref": "crawl-example",
      "observed_at": "2026-11-04T09:02:00Z",
      "response": {
        "status": "completed",
        "creditsUsed": 2,
        "data": [{ "metadata": { "statusCode": 200 } }]
      }
    }
  ]
}
```

Supply provider_ref when the status response omits its request ID. If both references are present, they must agree.

The adapter keeps reported credits and result presence, then discards result bodies. Missing creditsUsed remains unknown. A non-empty data array does not prove a correct or useful result.

## Interpreting cases

Charge and delivery states remain separate. A missing result does not establish refund eligibility. Guidance tells an operator what to inspect; it does not perform a recovery action.

All sample evidence is labelled **Demo data**. All file imports are labelled **Imported, not verified**. No import can upgrade its source to live or independently verified.

## Owner API

When the updated console backend is deployed:

| Route                          | Purpose                             |
| ------------------------------ | ----------------------------------- |
| GET /console-api/cases         | Jobs, operations, cases and summary |
| POST /console-api/cases/import | Import a supported JSON envelope    |
| POST /console-api/cases/demo   | Load examples; send an empty object |
| GET /console-api/cases/export  | Download normalized facts           |

An owner session is required. Owner writes require the configured origin. Agent payment keys cannot access these routes.

Cases data uses existing workspace SQLite storage with additive tables. Cases imports accept 1 MiB; other API limits remain unchanged. Imports do not change payment or routing behavior.
