# The first spend review

**Who to ask.** An engineering lead running paid research or enrichment jobs for customers, together with the person who reconciles the supplier bill. A good first pilot has one supplier that exposes request-level billing IDs and a job log that records those same IDs.

**An opening pitch**

> When a customer job fails, how do you tell whether the supplier still billed you? Give me ten minutes with the person who owns that reconciliation. We can match one week of supplier charges to your job log in your browser and leave you with the request IDs worth following up.

## Show the sample

1. Open **Try a spend review** from the homepage. The sample contains six distinct requests and four findings.
2. Find `req_8042`. The supplier reports $6.40 and the job reports failure. Find `req_8043`. That $4.80 charge has no corresponding job record. Together they explain the $11.20 flagged in USD. The pending 42-credit request appears separately.
3. Filter by `research-17` and export the filtered CSV. The engineering lead gets the request ID, job, charge, result, finding and suggested check. Switch to **All requests** to include the delivered call on that same job.

## Use the team's exports

Choose one supplier, one account and the same time window. Export one **final, nonnegative charge** per request, plus one final job result per request. Aggregated invoices, credits from different suppliers, refunds and multi-line price adjustments need preprocessing. If the systems do not share request IDs, record the supplier's request ID in the job log before trying this review.

| File | Required columns | Values |
| --- | --- | --- |
| Supplier billing | `request_id,amount,unit` | USD in dollars to two decimal places, or whole `credits` |
| Job log | `request_id,customer_id,job_id,result` | `delivered`, `failed` or `pending` |

Choose **Compare my CSVs**. Both examples are downloadable in the dialog. Use opaque IDs. The app reads the CSVs locally in memory and discards them on refresh. It accepts UTF-8 CSVs up to 2 MiB and 10,000 data rows per file. Either file can contain just its header. Duplicate request IDs in one file stop the comparison so the operator can resolve them. Matching trims surrounding whitespace and preserves case.

**Judge the pilot with the team.** Record their usual reconciliation time, how long this review took, how many findings they could confirm in the original systems, and how many were explained by billing delays or the export window. The dollar and credit totals describe flagged records. Count recovered money only when the supplier confirms a credit or refund. If the team wants to run the review again with its next bill, discuss one supplier integration.
