import { z } from "zod";
import { AppError } from "../errors.js";

export const CaseSourceSchema = z.enum(["demo", "imported_unverified"]);
export type CaseSource = z.infer<typeof CaseSourceSchema>;
export const CaseUnitSchema = z.enum(["usd_cent", "credit"]);
export type CaseUnit = z.infer<typeof CaseUnitSchema>;
const Identifier = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
  .refine(
    (v) => !/(?:sk_(?:live|test)_|rg_test\.|ih_recovery\.|bearer)/i.test(v),
    "Use a record identifier, never a credential",
  );
const Minor = z.number().int().min(0).max(100000000);
export const CaseEventKindSchema = z.enum([
  "bound_set",
  "reservation_opened",
  "reservation_released",
  "charge_reported",
  "no_charge_reported",
  "refund_requested",
  "refund_reported",
  "execution_started",
  "execution_completed",
  "execution_failed",
  "result_delivered",
  "result_failed",
]);
const AmountKinds = new Set([
  "bound_set",
  "reservation_opened",
  "charge_reported",
  "refund_reported",
]);
export const CaseEventInputSchema = z
  .strictObject({
    event_id: Identifier,
    operation_id: Identifier,
    job_id: Identifier,
    customer_id: Identifier,
    provider: z.enum(["stripe", "firecrawl", "custom"]),
    provider_ref: Identifier,
    unit: CaseUnitSchema,
    kind: CaseEventKindSchema,
    amount_minor: Minor.optional(),
    occurred_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((event, ctx) => {
    if (AmountKinds.has(event.kind) !== (event.amount_minor !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["amount_minor"],
        message: AmountKinds.has(event.kind)
          ? "This event requires an integer amount in its declared unit"
          : "This event must not include an amount",
      });
    }
  })
  .transform((event) => ({
    ...event,
    occurred_at: new Date(event.occurred_at).toISOString(),
  }));
export type CaseEventInput = z.infer<typeof CaseEventInputSchema>;
export type CaseEvent = CaseEventInput & {
  source: CaseSource;
  received_at: string;
};
export type CaseKind =
  | "charged_without_result"
  | "charge_unconfirmed"
  | "refund_pending"
  | "reservation_unresolved"
  | "amount_mismatch";
export type ChargeState =
  | "unknown"
  | "reserved"
  | "reported_charged"
  | "reported_not_charged"
  | "refund_requested"
  | "partially_refunded"
  | "reported_refunded";
export type DeliveryState =
  | "unknown"
  | "pending"
  | "reported_delivered"
  | "reported_failed";
export type UnitTotal = {
  unit: CaseUnit;
  charged_minor: number;
  reserved_minor: number;
  refunded_minor: number;
};
export type CaseOperation = {
  operation_id: string;
  job_id: string;
  customer_id: string;
  provider: CaseEventInput["provider"];
  provider_ref: string;
  unit: CaseUnit;
  source: CaseSource;
  charge_state: ChargeState;
  delivery_state: DeliveryState;
  charge_minor: number | null;
  refunded_minor: number;
  reservation_minor: number | null;
  bound_minor: number | null;
  updated_at: string;
  events: CaseEvent[];
};
export type CaseItem = {
  id: string;
  operation_id: string;
  job_id: string;
  customer_id: string;
  provider: CaseEventInput["provider"];
  kind: CaseKind;
  title: string;
  reason: string;
  next_step: string;
  source: CaseSource;
  updated_at: string;
};
export type CaseJob = {
  job_id: string;
  customer_id: string;
  operations: number;
  open_cases: number;
  totals: UnitTotal[];
  source: CaseSource | "mixed";
  updated_at: string;
};
export type CasesSnapshot = {
  mode: "read_only";
  jobs: CaseJob[];
  operations: CaseOperation[];
  cases: CaseItem[];
  summary: {
    jobs: number;
    operations: number;
    open_cases: number;
    demo_cases: number;
    imported_cases: number;
    totals: UnitTotal[];
  };
};
export type ImportResult = {
  added: number;
  duplicates: number;
  operations: number;
  open_cases: number;
};
export const MAX_CASE_EVENTS = 1000;
export const MAX_CASE_OPERATIONS = 200;
export const MAX_IMPORT_EVENTS = 1000;
export function eventPayload(event: CaseEventInput): string {
  return JSON.stringify({
    event_id: event.event_id,
    operation_id: event.operation_id,
    job_id: event.job_id,
    customer_id: event.customer_id,
    provider: event.provider,
    provider_ref: event.provider_ref,
    unit: event.unit,
    kind: event.kind,
    ...(event.amount_minor === undefined
      ? {}
      : { amount_minor: event.amount_minor }),
    occurred_at: event.occurred_at,
  });
}
function identity(event: CaseEvent): string {
  return JSON.stringify([
    event.customer_id,
    event.job_id,
    event.provider,
    event.provider_ref,
    event.unit,
    event.source,
  ]);
}
export function mergeCaseEvents(
  existing: CaseEvent[],
  incoming: CaseEventInput[],
  source: CaseSource,
  receivedAt: string,
) {
  CaseSourceSchema.parse(source);
  const received_at = z.iso.datetime({ offset: true }).parse(receivedAt);
  const parsed = z
    .array(CaseEventInputSchema)
    .min(1)
    .max(MAX_IMPORT_EVENTS)
    .parse(incoming);
  const byId = new Map(existing.map((e) => [e.event_id, e]));
  const opIdentity = new Map(
    existing.map((e) => [e.operation_id, identity(e)]),
  );
  let added = 0,
    duplicates = 0;
  for (const input of parsed) {
    const event: CaseEvent = { ...input, source, received_at };
    const previous = byId.get(event.event_id);
    if (previous) {
      if (eventPayload(previous) !== eventPayload(event))
        throw new AppError(409, "This event ID already has different facts");
      duplicates++;
      continue;
    }
    const bound = opIdentity.get(event.operation_id);
    if (bound && bound !== identity(event))
      throw new AppError(
        409,
        "An operation ID must keep the same customer, job, provider reference, unit and source",
      );
    opIdentity.set(event.operation_id, identity(event));
    byId.set(event.event_id, event);
    added++;
  }
  if (byId.size > MAX_CASE_EVENTS || opIdentity.size > MAX_CASE_OPERATIONS)
    throw new AppError(
      409,
      "Cases storage limit reached. Export records before starting another workspace.",
    );
  return { events: [...byId.values()], added, duplicates };
}
function totals(operations: CaseOperation[]): UnitTotal[] {
  const units = new Map<CaseUnit, UnitTotal>();
  for (const op of operations) {
    const total = units.get(op.unit) ?? {
      unit: op.unit,
      charged_minor: 0,
      reserved_minor: 0,
      refunded_minor: 0,
    };
    total.charged_minor += op.charge_minor ?? 0;
    total.reserved_minor += op.reservation_minor ?? 0;
    total.refunded_minor += op.refunded_minor;
    units.set(op.unit, total);
  }
  return [...units.values()].sort((a, b) => a.unit.localeCompare(b.unit));
}
export function buildCasesSnapshot(events: CaseEvent[]): CasesSnapshot {
  const grouped = new Map<string, CaseEvent[]>();
  for (const event of events) {
    const group = grouped.get(event.operation_id) ?? [];
    group.push(event);
    grouped.set(event.operation_id, group);
  }
  const operations: CaseOperation[] = [];
  const cases: CaseItem[] = [];
  for (const [operation_id, raw] of grouped) {
    const priority = (kind: CaseEventInput["kind"]) =>
      kind === "bound_set" ? 0 : 1;
    const ordered = [...raw].sort(
      (a, b) =>
        a.occurred_at.localeCompare(b.occurred_at) ||
        priority(a.kind) - priority(b.kind) ||
        a.event_id.localeCompare(b.event_id),
    );
    const first = ordered[0]!;
    let charge: number | null = null,
      refunded = 0,
      bound: number | null = null,
      reservation: number | null = null;
    let boundAtCharge: number | null = null,
      violatingBound: number | null = null;
    let execution: "unknown" | "started" | "completed" | "failed" = "unknown";
    let explicitDelivery = false;
    let delivery: DeliveryState = "unknown",
      noChargeAt = "",
      chargeAt = "",
      refundRequested = false;
    for (const event of ordered) {
      switch (event.kind) {
        case "bound_set":
          bound = event.amount_minor!;
          break;
        case "reservation_opened":
          reservation = event.amount_minor!;
          break;
        case "reservation_released":
          reservation = null;
          break;
        case "charge_reported":
          if (
            bound !== null &&
            event.amount_minor! > bound &&
            violatingBound === null
          )
            violatingBound = bound;
          boundAtCharge = bound;
          charge = Math.max(charge ?? 0, event.amount_minor!);
          chargeAt = event.occurred_at;
          break;
        case "no_charge_reported":
          noChargeAt = event.occurred_at;
          break;
        case "refund_requested":
          refundRequested = true;
          break;
        case "refund_reported":
          refunded = Math.max(refunded, event.amount_minor!);
          break;
        case "execution_started":
          execution = "started";
          if (!explicitDelivery) delivery = "pending";
          break;
        case "execution_completed":
          execution = "completed";
          if (!explicitDelivery) delivery = "unknown";
          break;
        case "execution_failed":
          execution = "failed";
          if (!explicitDelivery) delivery = "reported_failed";
          break;
        case "result_failed":
          explicitDelivery = true;
          delivery = "reported_failed";
          break;
        case "result_delivered":
          explicitDelivery = true;
          delivery = "reported_delivered";
          break;
      }
    }
    const fullyRefunded = charge !== null && charge > 0 && refunded >= charge;
    const charge_state: ChargeState = fullyRefunded
      ? "reported_refunded"
      : refunded > 0
        ? "partially_refunded"
        : refundRequested
          ? "refund_requested"
          : charge !== null
            ? "reported_charged"
            : noChargeAt
              ? "reported_not_charged"
              : reservation !== null
                ? "reserved"
                : "unknown";
    const updated_at = ordered.at(-1)!.occurred_at;
    const op: CaseOperation = {
      operation_id,
      job_id: first.job_id,
      customer_id: first.customer_id,
      provider: first.provider,
      provider_ref: first.provider_ref,
      unit: first.unit,
      source: first.source,
      charge_state,
      delivery_state: delivery,
      charge_minor: charge,
      refunded_minor: refunded,
      reservation_minor: reservation,
      bound_minor: charge !== null ? (violatingBound ?? boundAtCharge) : bound,
      updated_at,
      events: ordered,
    };
    operations.push(op);
    let kind: CaseKind | null = null,
      title = "",
      reason = "",
      next_step = "";
    if (
      violatingBound !== null ||
      (charge !== null && refunded > charge) ||
      (charge !== null && noChargeAt && noChargeAt >= chargeAt)
    ) {
      kind = "amount_mismatch";
      title = "Charge evidence disagrees";
      reason =
        violatingBound !== null
          ? "A charge observation exceeded the bound recorded at that time. A later bound does not authorize an earlier charge."
          : refunded > (charge ?? 0)
            ? "The reported refund exceeds the recorded charge."
            : "The operation has conflicting charge and no-charge observations.";
      next_step =
        "Compare the original supplier reference and billing records. Do not create a replacement purchase.";
    } else if (refundRequested && !fullyRefunded) {
      kind = "refund_pending";
      title = "Refund not confirmed";
      reason =
        "A refund was requested, but a full refund has not been reported.";
      next_step =
        "Check the supplier's original refund record and import its final evidence.";
    } else if (
      (charge ?? 0) > refunded &&
      (delivery === "unknown" || delivery === "reported_failed")
    ) {
      kind = "charged_without_result";
      title = "Charge reported, result not recorded";
      reason =
        delivery === "reported_failed"
          ? "The records report a charge and a failed result."
          : "The records report a charge without delivery evidence.";
      next_step =
        "Retrieve or inspect the original result. A missing result alone does not establish refund eligibility.";
    } else if (
      reservation !== null &&
      reservation > 0 &&
      (delivery === "reported_failed" ||
        execution === "completed" ||
        charge !== null ||
        noChargeAt !== "")
    ) {
      kind = "reservation_unresolved";
      title = "Reservation still open";
      reason =
        "The recorded reservation has no release event despite a later outcome.";
      next_step =
        "Reconcile the original operation. Release a hold only when your provider and accounting rules permit it.";
    } else if (
      (delivery === "reported_delivered" ||
        delivery === "reported_failed" ||
        execution === "completed" ||
        refunded > 0) &&
      charge === null &&
      !noChargeAt
    ) {
      kind = "charge_unconfirmed";
      title = "Final charge unknown";
      reason = "An outcome is reported, but the final charge is not recorded.";
      next_step =
        "Obtain the provider's final usage or billing record. Do not estimate a cash charge from credits.";
    }
    if (kind)
      cases.push({
        id: operation_id + ":" + kind,
        operation_id,
        job_id: first.job_id,
        customer_id: first.customer_id,
        provider: first.provider,
        kind,
        title,
        reason,
        next_step,
        source: first.source,
        updated_at,
      });
  }
  operations.sort(
    (a, b) =>
      b.updated_at.localeCompare(a.updated_at) ||
      a.operation_id.localeCompare(b.operation_id),
  );
  cases.sort(
    (a, b) =>
      b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id),
  );
  const byJob = new Map<string, CaseOperation[]>();
  for (const op of operations) {
    const key = JSON.stringify([op.customer_id, op.job_id]);
    const group = byJob.get(key) ?? [];
    group.push(op);
    byJob.set(key, group);
  }
  const jobs: CaseJob[] = [...byJob.values()].map((group) => {
    const sources = new Set(group.map((op) => op.source)),
      ids = new Set(group.map((op) => op.operation_id));
    return {
      job_id: group[0]!.job_id,
      customer_id: group[0]!.customer_id,
      operations: group.length,
      open_cases: cases.filter((item) => ids.has(item.operation_id)).length,
      totals: totals(group),
      source: sources.size === 1 ? group[0]!.source : "mixed",
      updated_at: group
        .map((op) => op.updated_at)
        .sort()
        .at(-1)!,
    };
  });
  return {
    mode: "read_only",
    jobs,
    operations,
    cases,
    summary: {
      jobs: jobs.length,
      operations: operations.length,
      open_cases: cases.length,
      demo_cases: cases.filter((item) => item.source === "demo").length,
      imported_cases: cases.filter(
        (item) => item.source === "imported_unverified",
      ).length,
      totals: totals(operations),
    },
  };
}
