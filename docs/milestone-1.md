# Milestone 1 acceptance

Validated on 2026-10-25 against the running cloud instance. Test funds only; chain ID **84532** was checked before execution.

| Check | Observed result |
| --- | --- |
| Allowed $5 payment | Completed a real test USDC transfer to the dedicated demo merchant. Receipt succeeded and the expected ERC-20 Transfer event was verified. |
| Human approval at $45 | Entered pending approval. The real ntfy publish API accepted the notification. The owner rejected it through the authenticated public approval page; the audit identifies `owner:approval-token`. No transaction was created for that request. |
| Daily overspending | A subsequent $100 request was denied because $5 was already spent against the $100 daily cap. A separate direct $150 attempt was also denied by the hard limits. |
| Duplicate retry | The same normalized $5 intent/idempotency key returned the original payment ID and transaction hash. The payer's confirmed transaction count was one. |
| Storage/audit | Decisions, notification publication, owner rejection, completion and retry were recorded in SQLite. |
| Public access | HTTPS health and agent-authenticated limits reads passed. Anonymous approvals returned 401; owner Basic authentication returned the page. Private `.env` was not served. |

Real transfer:

```text
0xa696f9a4fd75ccd9fa53a90da1042de49f3fb83ae1f056a3a93ead842cef3f5e
```

After the transfer, on-chain test USDC balances were 15 for the payer and 5 for the merchant. The live demo script completed successfully with the rejection branch. The public URL is temporary and is intentionally not pinned here.

The 43 automated tests, lint, type check, build and offline demo passed for this implementation on Node 24. Automated transfer/notification tests use explicit mocks; HTTP, SQLite and official MCP clients (including stdio) are exercised directly. CI is configured for Node 20, 22 and 24; that remote matrix has not been run from this cloud instance.

Limitations: the $45 live approval-and-transfer branch was not funded or exercised (the user chose rejection); native ntfy app receipt/action buttons have not been independently confirmed. Publication and fresh-task restoration are separate from current-instance validation. No keys, topics, approval tokens or database contents are included in this evidence file.
