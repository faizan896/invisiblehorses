import { z } from "zod";
import { AppError } from "../errors.js";
import {
  CaseEventInputSchema,
  type CaseEventInput,
  MAX_IMPORT_EVENTS,
} from "./model.js";
const UnknownRecords = z.array(z.unknown()).min(1).max(100);
const Envelope = z.discriminatedUnion("format", [
  z.strictObject({
    format: z.literal("normalized"),
    events: z.array(CaseEventInputSchema).min(1).max(MAX_IMPORT_EVENTS),
  }),
  z.strictObject({ format: z.literal("stripe"), records: UnknownRecords }),
  z.strictObject({ format: z.literal("firecrawl"), records: UnknownRecords }),
]);
const rawObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError(400, "Expected a provider record object");
  return value as Record<string, unknown>;
};
const amount = z.number().int().min(0).max(100000000);
const contextSchema = z.strictObject({
  job_id: z.string(),
  customer_id: z.string(),
  operation_id: z.string(),
});
function digest(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 14695981039346656037n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}
function stripe(record: unknown): CaseEventInput[] {
  const supplied = rawObject(record);
  const wrapper =
    supplied.response === undefined
      ? null
      : z
          .strictObject({ context: contextSchema, response: z.unknown() })
          .parse(supplied);
  const raw = rawObject(wrapper ? wrapper.response : supplied),
    object = rawObject(rawObject(raw.data).object);
  if (
    ![
      "charge.succeeded",
      "charge.captured",
      "charge.failed",
      "charge.refunded",
    ].includes(String(raw.type))
  )
    throw new AppError(
      400,
      "Stripe import supports charge.succeeded, charge.captured, charge.failed and charge.refunded exports only",
    );
  if (object.currency !== "usd")
    throw new AppError(400, "Stripe imports currently support USD only");
  const metadata =
    object.metadata === undefined ? {} : rawObject(object.metadata);
  if (wrapper)
    for (const key of ["job_id", "customer_id", "operation_id"] as const) {
      if (metadata[key] !== undefined && metadata[key] !== wrapper.context[key])
        throw new AppError(
          400,
          "Stripe mapping conflicts with the event metadata",
        );
    }
  const parsedContext = contextSchema.safeParse(
    wrapper
      ? wrapper.context
      : {
          job_id: metadata.job_id,
          customer_id: metadata.customer_id,
          operation_id: metadata.operation_id,
        },
  );
  if (!parsedContext.success)
    throw new AppError(
      400,
      "Add job_id, customer_id and operation_id in Stripe metadata or a context/response wrapper",
    );
  const context = parsedContext.data;
  const created = z.number().int().min(0).max(8640000000000).parse(raw.created);
  const id = z.string().min(1).max(100).parse(raw.id);
  const common = {
    ...context,
    provider: "stripe" as const,
    provider_ref: z.string().parse(object.id),
    unit: "usd_cent" as const,
    occurred_at: new Date(created * 1000).toISOString(),
  };
  if (raw.type === "charge.failed") {
    if (object.paid !== false)
      throw new AppError(
        400,
        "The failed charge must explicitly report paid: false",
      );
    return [
      { ...common, event_id: id + ":failed", kind: "no_charge_reported" },
    ];
  }
  if (object.paid !== true || object.captured !== true)
    throw new AppError(
      400,
      "An authorization is not a captured charge. Import captured charge records only.",
    );
  const captured = amount.parse(object.amount_captured);
  const events: CaseEventInput[] = [
    {
      ...common,
      event_id: id + ":charge",
      kind: "charge_reported",
      amount_minor: captured,
    },
  ];
  if (raw.type === "charge.refunded") {
    const aggregate = amount.parse(object.amount_refunded);
    const refunds =
      object.refunds === undefined
        ? []
        : z.array(z.unknown()).max(100).parse(rawObject(object.refunds).data);
    const seen = new Set<string>();
    let confirmed = 0,
      unresolved = refunds.length === 0 && aggregate > 0;
    for (const item of refunds) {
      const refund = rawObject(item),
        refundId = z.string().min(1).max(120).parse(refund.id);
      if (seen.has(refundId))
        throw new AppError(400, "Duplicate refund identity in Stripe export");
      seen.add(refundId);
      if (refund.currency !== "usd")
        throw new AppError(400, "Stripe refund currency must be USD");
      const value = amount.parse(refund.amount);
      if (refund.status === "succeeded") confirmed += value;
      else unresolved = true;
    }
    if (confirmed > aggregate)
      throw new AppError(
        400,
        "Stripe refund details exceed the aggregate amount",
      );
    if (confirmed > 0)
      events.push({
        ...common,
        event_id: id + ":refund",
        kind: "refund_reported",
        amount_minor: confirmed,
      });
    if (unresolved || aggregate > confirmed)
      events.push({
        ...common,
        event_id: id + ":refund-request",
        kind: "refund_requested",
      });
  }
  return events;
}
function firecrawl(record: unknown): CaseEventInput[] {
  const wrapper = z
    .strictObject({
      context: contextSchema,
      observed_at: z.iso.datetime({ offset: true }),
      provider_ref: z.string().optional(),
      response: z.unknown(),
    })
    .parse(record);
  const response = rawObject(wrapper.response),
    context = wrapper.context;
  const status = z
    .enum(["scraping", "completed", "failed", "cancelled"])
    .parse(response.status);
  if (
    wrapper.provider_ref !== undefined &&
    response.id !== undefined &&
    wrapper.provider_ref !== response.id
  )
    throw new AppError(
      400,
      "Firecrawl mapping conflicts with the response job ID",
    );
  const id = z.string().parse(wrapper.provider_ref ?? response.id);
  const credits =
    response.creditsUsed === undefined
      ? undefined
      : amount.parse(response.creditsUsed);
  const hasData = Array.isArray(response.data) && response.data.length > 0;
  const common = {
    ...context,
    provider: "firecrawl" as const,
    provider_ref: id,
    unit: "credit" as const,
    occurred_at: wrapper.observed_at,
  };
  const base =
    "fc_" +
    digest([
      context,
      id,
      status,
      credits ?? null,
      hasData,
      wrapper.observed_at,
    ]);
  const events: CaseEventInput[] = [];
  if (credits !== undefined)
    events.push(
      credits > 0
        ? {
            ...common,
            event_id: base + ":charge",
            kind: "charge_reported",
            amount_minor: credits,
          }
        : { ...common, event_id: base + ":free", kind: "no_charge_reported" },
    );
  if (status === "scraping")
    events.push({
      ...common,
      event_id: base + ":started",
      kind: "execution_started",
    });
  else if (status === "completed")
    events.push({
      ...common,
      event_id: base + ":result",
      kind: hasData ? "result_delivered" : "execution_completed",
    });
  else
    events.push({
      ...common,
      event_id: base + ":failed",
      kind: "execution_failed",
    });
  return events;
}
export function parseImport(input: unknown): CaseEventInput[] {
  const envelope = Envelope.parse(input);
  const events =
    envelope.format === "normalized"
      ? envelope.events
      : envelope.records.flatMap((record) =>
          envelope.format === "stripe" ? stripe(record) : firecrawl(record),
        );
  return z
    .array(CaseEventInputSchema)
    .min(1)
    .max(MAX_IMPORT_EVENTS)
    .parse(events);
}
