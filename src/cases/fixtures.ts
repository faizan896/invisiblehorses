import type { CaseEventInput } from "./model.js";
export function demoEvents(): CaseEventInput[] {
  const at = (minute: number) =>
    "2026-11-04T09:" + String(minute).padStart(2, "0") + ":00.000Z";
  const base = (
    id: string,
    job: string,
    provider: "custom" | "firecrawl",
    unit: "usd_cent" | "credit",
  ) => ({
    operation_id: "demo_" + id,
    job_id: "demo_" + job,
    customer_id: "demo_acme",
    provider,
    provider_ref: "demo_ref_" + id,
    unit,
  });
  return [
    {
      ...base("missing", "research", "custom", "usd_cent"),
      event_id: "demo_missing_charge",
      kind: "charge_reported",
      amount_minor: 1250,
      occurred_at: at(1),
    },
    {
      ...base("missing", "research", "custom", "usd_cent"),
      event_id: "demo_missing_failed",
      kind: "result_failed",
      occurred_at: at(2),
    },
    {
      ...base("unknown", "research", "firecrawl", "credit"),
      event_id: "demo_unknown_result",
      kind: "result_delivered",
      occurred_at: at(3),
    },
    {
      ...base("refund", "enrichment", "custom", "usd_cent"),
      event_id: "demo_refund_charge",
      kind: "charge_reported",
      amount_minor: 7500,
      occurred_at: at(4),
    },
    {
      ...base("refund", "enrichment", "custom", "usd_cent"),
      event_id: "demo_refund_request",
      kind: "refund_requested",
      occurred_at: at(5),
    },
    {
      ...base("hold", "enrichment", "custom", "usd_cent"),
      event_id: "demo_hold_open",
      kind: "reservation_opened",
      amount_minor: 2000,
      occurred_at: at(6),
    },
    {
      ...base("hold", "enrichment", "custom", "usd_cent"),
      event_id: "demo_hold_failed",
      kind: "execution_failed",
      occurred_at: at(7),
    },
    {
      ...base("clear", "research", "custom", "usd_cent"),
      event_id: "demo_clear_charge",
      kind: "charge_reported",
      amount_minor: 500,
      occurred_at: at(8),
    },
    {
      ...base("clear", "research", "custom", "usd_cent"),
      event_id: "demo_clear_result",
      kind: "result_delivered",
      occurred_at: at(9),
    },
  ];
}
