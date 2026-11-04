import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CasesService } from "../src/cases/service.js";
import {
  buildCasesSnapshot,
  mergeCaseEvents,
  type CaseEventInput,
} from "../src/cases/model.js";
import { parseImport } from "../src/cases/adapters.js";
const databases: Database.Database[] = [];
function setup(id = "workspace_a", db?: Database.Database) {
  const database = db ?? new Database(":memory:");
  if (!db) databases.push(database);
  return new CasesService(database, id, () => new Date("2026-11-04T10:00:00Z"));
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const event = (patch: Partial<CaseEventInput> = {}): CaseEventInput => ({
  event_id: "event_1",
  operation_id: "operation_1",
  job_id: "job_1",
  customer_id: "customer_1",
  provider: "custom",
  provider_ref: "request_1",
  unit: "usd_cent",
  kind: "charge_reported",
  amount_minor: 1250,
  occurred_at: "2026-11-04T09:00:00Z",
  ...patch,
});
const input = (events: unknown[]) => ({ format: "normalized", events });
const fact = (
  kind: CaseEventInput["kind"],
  patch: Partial<CaseEventInput> = {},
) => {
  const row = event({ kind, ...patch });
  if (
    ![
      "bound_set",
      "reservation_opened",
      "charge_reported",
      "refund_reported",
    ].includes(kind)
  )
    delete row.amount_minor;
  return row;
};
describe("Cases records", () => {
  it("starts empty and loads a repeatable, explicitly synthetic demo", () => {
    const service = setup();
    expect(service.list().summary.open_cases).toBe(0);
    expect(service.loadDemo()).toMatchObject({
      added: 9,
      operations: 5,
      open_cases: 4,
    });
    expect(service.loadDemo()).toMatchObject({ added: 0, duplicates: 9 });
    expect(service.list().operations.every((x) => x.source === "demo")).toBe(
      true,
    );
    expect(
      service
        .list()
        .cases.map((x) => x.kind)
        .sort(),
    ).toEqual([
      "charge_unconfirmed",
      "charged_without_result",
      "refund_pending",
      "reservation_unresolved",
    ]);
    expect(new CasesService(service.db, service.workspaceId).list()).toEqual(
      service.list(),
    );
  });
  it("isolates workspaces even when sharing one physical database", () => {
    const first = setup();
    const second = setup("workspace_b", first.db as Database.Database);
    first.importRecords(input([event()]));
    expect(second.list().operations).toEqual([]);
    second.importRecords(input([event({ amount_minor: 999 })]));
    expect(first.list().operations[0]!.charge_minor).toBe(1250);
    expect(second.list().operations[0]!.charge_minor).toBe(999);
  });
  it("deduplicates identical events but atomically rejects conflicting facts", () => {
    const service = setup();
    service.importRecords(input([event()]));
    expect(service.importRecords(input([event()]))).toMatchObject({
      added: 0,
      duplicates: 1,
    });
    expect(() =>
      service.importRecords(
        input([
          event({
            event_id: "new_event",
            operation_id: "new_operation",
            provider_ref: "new_ref",
          }),
          event({ amount_minor: 999 }),
        ]),
      ),
    ).toThrow(/different facts/);
    expect(service.list().operations).toHaveLength(1);
    expect(() =>
      service.importRecords(
        input([event({ event_id: "new_event", provider_ref: "other_ref" })]),
      ),
    ).toThrow(/same customer/);
  });
  it("does not treat a refund request or partial refund as a completed refund", () => {
    const service = setup();
    service.importRecords(
      input([event(), fact("result_failed", { event_id: "failed" })]),
    );
    service.importRecords(
      input([
        fact("refund_requested", {
          event_id: "request_refund",
          occurred_at: "2026-11-04T09:01:00Z",
        }),
      ]),
    );
    expect(service.list().operations[0]!.charge_state).toBe("refund_requested");
    expect(service.list().cases[0]!.kind).toBe("refund_pending");
    service.importRecords(
      input([
        fact("refund_reported", {
          event_id: "partial",
          amount_minor: 500,
          occurred_at: "2026-11-04T09:02:00Z",
        }),
      ]),
    );
    expect(service.list().operations[0]!.charge_state).toBe(
      "partially_refunded",
    );
    expect(service.list().cases[0]!.kind).toBe("refund_pending");
    service.importRecords(
      input([
        fact("refund_reported", {
          event_id: "full",
          amount_minor: 1250,
          occurred_at: "2026-11-04T09:03:00Z",
        }),
      ]),
    );
    expect(service.list().operations[0]!.refunded_minor).toBe(1250);
    expect(service.list().operations[0]!.charge_state).toBe(
      "reported_refunded",
    );
    expect(service.list().cases).toEqual([]);
  });
  it("orders observations by occurrence time, not arrival order", () => {
    const service = setup();
    service.importRecords(
      input([
        event(),
        fact("result_delivered", {
          event_id: "delivered",
          occurred_at: "2026-11-04T09:05:00Z",
        }),
      ]),
    );
    service.importRecords(
      input([
        fact("result_failed", {
          event_id: "earlier_failure",
          occurred_at: "2026-11-04T09:01:00Z",
        }),
      ]),
    );
    expect(service.list().operations[0]!.delivery_state).toBe(
      "reported_delivered",
    );
    expect(service.list().cases).toHaveLength(0);
  });
  it("never turns failed execution into proof that no charge occurred", () => {
    const service = setup();
    service.importRecords(
      input([
        fact("reservation_opened", { amount_minor: 500 }),
        fact("execution_failed", { event_id: "failed" }),
      ]),
    );
    expect(service.list().operations[0]!.charge_state).toBe("reserved");
    expect(service.list().cases[0]!.kind).toBe("reservation_unresolved");
  });
  it("keeps monetary and credit totals separate and customer job IDs distinct", () => {
    const service = setup();
    service.importRecords(
      input([
        event(),
        event({
          event_id: "credit",
          operation_id: "credit_op",
          provider_ref: "crawl_1",
          provider: "firecrawl",
          unit: "credit",
          amount_minor: 3,
        }),
        event({
          event_id: "other_customer",
          operation_id: "other_op",
          provider_ref: "request_2",
          customer_id: "customer_2",
          amount_minor: 500,
        }),
      ]),
    );
    const state = service.list();
    expect(state.jobs).toHaveLength(2);
    expect(state.summary.totals).toEqual([
      {
        unit: "credit",
        charged_minor: 3,
        reserved_minor: 0,
        refunded_minor: 0,
      },
      {
        unit: "usd_cent",
        charged_minor: 1750,
        reserved_minor: 0,
        refunded_minor: 0,
      },
    ]);
  });
  it("reports a charge above its bound and preserves conflicting no-charge evidence", () => {
    const service = setup();
    service.importRecords(
      input([
        event(),
        fact("bound_set", { event_id: "bound", amount_minor: 1000 }),
      ]),
    );
    expect(service.list().cases[0]!.kind).toBe("amount_mismatch");
    const other = setup("other");
    other.importRecords(
      input([
        event(),
        fact("no_charge_reported", {
          event_id: "conflict",
          occurred_at: "2026-11-04T09:02:00Z",
        }),
      ]),
    );
    expect(other.list().operations[0]!.charge_minor).toBe(1250);
    expect(other.list().cases[0]!.kind).toBe("amount_mismatch");
  });
  it("rejects forged provenance and malformed batches without storing anything", () => {
    const service = setup();
    expect(() =>
      service.importRecords(
        input([{ ...event(), source: "provider_verified" }]),
      ),
    ).toThrow();
    expect(() =>
      service.importRecords(
        input(
          [
            event(),
            fact("result_delivered", { event_id: "bad", amount_minor: 5 }),
          ].map((e, i) => (i ? { ...e, amount_minor: 5 } : e)),
        ),
      ),
    ).toThrow();
    expect(service.list().operations).toHaveLength(0);
  });
  it("exports only reimportable facts, preserving unverified provenance on a fresh import", () => {
    const service = setup();
    service.loadDemo();
    const exported = service.exportRecords();
    expect(Object.keys(exported).sort()).toEqual(["events", "format"]);
    expect(exported.format).toBe("normalized");
    expect(JSON.stringify(exported)).not.toContain("received_at");
    expect(JSON.stringify(exported)).not.toContain('"source"');
    expect(service.importRecords(exported).added).toBe(0);
    const next = setup("next");
    next.importRecords(exported);
    expect(
      next.list().operations.every((x) => x.source === "imported_unverified"),
    ).toBe(true);
  });
  it("enforces operation capacity atomically", () => {
    const service = setup();
    const records = Array.from({ length: 200 }, (_, i) =>
      event({
        event_id: "event_" + i,
        operation_id: "op_" + i,
        provider_ref: "ref_" + i,
      }),
    );
    service.importRecords(input(records));
    expect(() =>
      service.importRecords(
        input([
          event({
            event_id: "extra",
            operation_id: "extra",
            provider_ref: "extra",
          }),
        ]),
      ),
    ).toThrow(/storage limit/);
    expect(service.list().operations).toHaveLength(200);
  });
});
const stripeRecord = (patch: Record<string, unknown> = {}) => ({
  id: "evt_stripe",
  type: "charge.succeeded",
  created: 1793782800,
  data: {
    object: {
      id: "ch_1",
      currency: "usd",
      paid: true,
      captured: true,
      amount_captured: 1250,
      amount_refunded: 0,
      metadata: {
        job_id: "job_1",
        customer_id: "customer_1",
        operation_id: "op_1",
      },
      ...patch,
    },
  },
});
describe("provider imports", () => {
  it("extracts only normalized Stripe facts and rejects uncaptured or non-USD charges", () => {
    const service = setup();
    service.importRecords({
      format: "stripe",
      records: [
        stripeRecord({
          api_key: "NEVER_STORE",
          billing_details: { email: "private@example.test" },
          raw_secret: "DO_NOT_STORE",
        }),
      ],
    });
    const exported = JSON.stringify(service.exportRecords());
    expect(exported).not.toContain("NEVER_STORE");
    expect(exported).not.toContain("private@example.test");
    expect(service.list().operations[0]!.source).toBe("imported_unverified");
    expect(() =>
      parseImport({
        format: "stripe",
        records: [stripeRecord({ captured: false })],
      }),
    ).toThrow(/authorization/);
    expect(() =>
      parseImport({
        format: "stripe",
        records: [stripeRecord({ currency: "eur" })],
      }),
    ).toThrow(/USD/);
  });
  it("normalizes cumulative partial Stripe refunds without asserting a full refund", () => {
    const record = stripeRecord({
      amount_refunded: 500,
      refunds: {
        data: [
          { id: "re_1", currency: "usd", amount: 500, status: "succeeded" },
        ],
      },
    });
    record.type = "charge.refunded";
    const events = parseImport({ format: "stripe", records: [record] });
    const merged = mergeCaseEvents(
      [],
      events,
      "imported_unverified",
      "2026-11-04T10:00:00Z",
    );
    const state = buildCasesSnapshot(merged.events);
    expect(state.operations[0]!.charge_state).toBe("partially_refunded");
    expect(state.operations[0]!.refunded_minor).toBe(500);
  });
  it("keeps missing Firecrawl costs unknown and discards returned document contents", () => {
    const service = setup();
    service.importRecords({
      format: "firecrawl",
      records: [
        {
          context: {
            job_id: "job_1",
            customer_id: "customer_1",
            operation_id: "crawl_op",
          },
          observed_at: "2026-11-04T09:00:00Z",
          response: {
            id: "crawl_1",
            status: "completed",
            data: [{ markdown: "PRIVATE_DOCUMENT" }],
            apiKey: "NEVER_STORE",
          },
        },
      ],
    });
    expect(service.list().operations[0]!.charge_minor).toBeNull();
    expect(service.list().cases[0]!.kind).toBe("charge_unconfirmed");
    expect(JSON.stringify(service.exportRecords())).not.toMatch(
      /PRIVATE_DOCUMENT|NEVER_STORE/,
    );
  });
  it("records reported Firecrawl credits as credits, never a dollar estimate", () => {
    const events = parseImport({
      format: "firecrawl",
      records: [
        {
          context: {
            job_id: "job_1",
            customer_id: "customer_1",
            operation_id: "crawl_op",
          },
          observed_at: "2026-11-04T09:00:00Z",
          response: {
            id: "crawl_1",
            status: "completed",
            creditsUsed: 3,
            data: [{}],
          },
        },
      ],
    });
    const state = buildCasesSnapshot(
      mergeCaseEvents([], events, "imported_unverified", "2026-11-04T10:00:00Z")
        .events,
    );
    expect(state.operations[0]).toMatchObject({
      unit: "credit",
      charge_minor: 3,
      delivery_state: "reported_delivered",
    });
    expect(state.cases).toEqual([]);
  });
});

describe("conservative evidence projection", () => {
  it("keeps an earlier charge-bound violation after a later higher bound", () => {
    const service = setup();
    service.importRecords(
      input([
        fact("bound_set", {
          event_id: "bound_before",
          amount_minor: 1000,
          occurred_at: "2026-11-04T09:00:00Z",
        }),
        event({
          event_id: "charge_after",
          occurred_at: "2026-11-04T09:01:00Z",
        }),
        fact("result_delivered", {
          event_id: "result",
          occurred_at: "2026-11-04T09:02:00Z",
        }),
      ]),
    );
    service.importRecords(
      input([
        fact("bound_set", {
          event_id: "bound_later",
          amount_minor: 2000,
          occurred_at: "2026-11-04T09:03:00Z",
        }),
      ]),
    );
    expect(service.list().cases[0]!.kind).toBe("amount_mismatch");
    expect(service.list().operations[0]!.bound_minor).toBe(1000);
  });
  it("does not apply a future bound retroactively to an earlier charge", () => {
    const service = setup();
    service.importRecords(
      input([
        event(),
        fact("result_delivered", {
          event_id: "result",
          occurred_at: "2026-11-04T09:01:00Z",
        }),
        fact("bound_set", {
          event_id: "later_bound",
          amount_minor: 1,
          occurred_at: "2026-11-04T09:02:00Z",
        }),
      ]),
    );
    expect(service.list().operations[0]!.bound_minor).toBeNull();
    expect(service.list().cases).toHaveLength(0);
  });
  it("retains unknown charge after failed Firecrawl work", () => {
    const service = setup();
    service.importRecords({
      format: "firecrawl",
      records: [
        {
          context: {
            job_id: "job_1",
            customer_id: "customer_1",
            operation_id: "crawl_op",
          },
          observed_at: "2026-11-04T09:00:00Z",
          response: { id: "crawl_1", status: "failed" },
        },
      ],
    });
    expect(service.list().operations[0]!.charge_state).toBe("unknown");
    expect(service.list().cases[0]!.kind).toBe("charge_unconfirmed");
  });
  it("accepts manually mapped Stripe captures without retaining raw fields", () => {
    const response = stripeRecord({
      metadata: {},
      raw_secret: "PRIVATE_KEY",
      billing_details: { email: "private@example.test" },
    });
    response.type = "charge.captured";
    const service = setup();
    service.importRecords({
      format: "stripe",
      records: [
        {
          context: {
            job_id: "mapped_job",
            customer_id: "mapped_customer",
            operation_id: "mapped_operation",
          },
          response,
        },
      ],
    });
    expect(service.list().operations[0]).toMatchObject({
      job_id: "mapped_job",
      customer_id: "mapped_customer",
      charge_minor: 1250,
      delivery_state: "unknown",
    });
    expect(JSON.stringify(service.exportRecords())).not.toMatch(
      /PRIVATE_KEY|private@example/,
    );
  });
  it("rejects contradictory Stripe mapping and explains missing job context", () => {
    expect(() =>
      parseImport({
        format: "stripe",
        records: [
          {
            context: {
              job_id: "wrong_job",
              customer_id: "customer_1",
              operation_id: "op_1",
            },
            response: stripeRecord(),
          },
        ],
      }),
    ).toThrow(/conflicts/);
    expect(() =>
      parseImport({
        format: "stripe",
        records: [stripeRecord({ metadata: {} })],
      }),
    ).toThrow(/context/);
  });
});

describe("Stripe refund evidence", () => {
  it("does not call an aggregate or a pending refund completed", () => {
    for (const details of [
      undefined,
      {
        data: [
          {
            id: "re_pending",
            currency: "usd",
            amount: 1250,
            status: "pending",
          },
        ],
      },
    ]) {
      const record = stripeRecord({
        amount_refunded: 1250,
        ...(details ? { refunds: details } : {}),
      });
      record.type = "charge.refunded";
      const service = setup("refund_" + (details ? "pending" : "aggregate"));
      service.importRecords({ format: "stripe", records: [record] });
      expect(service.list().operations[0]!.charge_state).toBe(
        "refund_requested",
      );
      expect(service.list().operations[0]!.refunded_minor).toBe(0);
      expect(service.list().cases[0]!.kind).toBe("refund_pending");
    }
  });
  it("only reports a full refund when identified successful refunds cover the charge", () => {
    const record = stripeRecord({
      amount_refunded: 1250,
      refunds: {
        data: [
          {
            id: "re_success",
            currency: "usd",
            amount: 1250,
            status: "succeeded",
          },
        ],
      },
    });
    record.type = "charge.refunded";
    const service = setup();
    service.importRecords({ format: "stripe", records: [record] });
    expect(service.list().operations[0]!.charge_state).toBe(
      "reported_refunded",
    );
    expect(service.list().cases).toHaveLength(0);
    const duplicated = stripeRecord({
      amount_refunded: 1250,
      refunds: {
        data: [
          { id: "same", currency: "usd", amount: 625, status: "succeeded" },
          { id: "same", currency: "usd", amount: 625, status: "succeeded" },
        ],
      },
    });
    duplicated.type = "charge.refunded";
    expect(() =>
      parseImport({ format: "stripe", records: [duplicated] }),
    ).toThrow(/Duplicate refund identity/);
  });
  it("does not count failed or absent refund statuses as finalized", () => {
    for (const status of ["failed", undefined]) {
      const record = stripeRecord({
        amount_refunded: 1250,
        refunds: {
          data: [{ id: "re_1", currency: "usd", amount: 1250, status }],
        },
      });
      record.type = "charge.refunded";
      const service = setup("refund_" + String(status));
      service.importRecords({ format: "stripe", records: [record] });
      expect(service.list().operations[0]!.refunded_minor).toBe(0);
      expect(service.list().cases[0]!.kind).toBe("refund_pending");
    }
  });
});
describe("Firecrawl path identity", () => {
  it("accepts the original crawl ID beside a status response that omits it", () => {
    const events = parseImport({
      format: "firecrawl",
      records: [
        {
          context: {
            job_id: "job_1",
            customer_id: "customer_1",
            operation_id: "crawl_op",
          },
          provider_ref: "crawl_from_url",
          observed_at: "2026-11-04T09:00:00Z",
          response: { status: "completed", creditsUsed: 3, data: [{}] },
        },
      ],
    });
    expect(
      events.every((event) => event.provider_ref === "crawl_from_url"),
    ).toBe(true);
    expect(() =>
      parseImport({
        format: "firecrawl",
        records: [
          {
            context: {
              job_id: "job_1",
              customer_id: "customer_1",
              operation_id: "crawl_op",
            },
            provider_ref: "one",
            observed_at: "2026-11-04T09:00:00Z",
            response: { id: "two", status: "completed", data: [{}] },
          },
        ],
      }),
    ).toThrow(/conflicts/);
  });
});

describe("execution completion is not delivery evidence", () => {
  it("keeps absent and empty completed Firecrawl outputs unknown, not failed", () => {
    for (const data of [undefined, []]) {
      const service = setup("completed_" + (data ? "empty" : "absent"));
      service.importRecords({
        format: "firecrawl",
        records: [
          {
            context: {
              job_id: "job_1",
              customer_id: "customer_1",
              operation_id: "crawl_op",
            },
            provider_ref: "crawl_1",
            observed_at: "2026-11-04T09:00:00Z",
            response: {
              status: "completed",
              creditsUsed: 3,
              ...(data ? { data } : {}),
            },
          },
        ],
      });
      const state = service.list();
      expect(state.operations[0]!.delivery_state).toBe("unknown");
      expect(
        state.operations[0]!.events.some(
          (event) => event.kind === "execution_completed",
        ),
      ).toBe(true);
      expect(
        state.operations[0]!.events.some(
          (event) => event.kind === "result_failed",
        ),
      ).toBe(false);
      expect(state.cases[0]!.kind).toBe("charged_without_result");
    }
  });
  it("flags unknown billing for terminal work even when no result evidence was exported", () => {
    for (const data of [undefined, []]) {
      const service = setup("unknown_" + (data ? "empty" : "absent"));
      service.importRecords({
        format: "firecrawl",
        records: [
          {
            context: {
              job_id: "job_1",
              customer_id: "customer_1",
              operation_id: "crawl_op",
            },
            provider_ref: "crawl_1",
            observed_at: "2026-11-04T09:00:00Z",
            response: { status: "completed", ...(data ? { data } : {}) },
          },
        ],
      });
      expect(service.list().operations[0]).toMatchObject({
        delivery_state: "unknown",
        charge_state: "unknown",
      });
      expect(service.list().cases[0]!.kind).toBe("charge_unconfirmed");
    }
  });
  it("preserves explicit delivery facts independently of later execution status", () => {
    const service = setup();
    service.importRecords(
      input([
        fact("result_delivered", {
          event_id: "result",
          occurred_at: "2026-11-04T09:00:00Z",
        }),
        fact("execution_completed", {
          event_id: "completed",
          occurred_at: "2026-11-04T09:01:00Z",
        }),
      ]),
    );
    expect(service.list().operations[0]!.delivery_state).toBe(
      "reported_delivered",
    );
  });
  it("replaces inferred pending or failed delivery with unknown on completion without evidence", () => {
    for (const previous of ["execution_started", "execution_failed"] as const) {
      const service = setup("previous_" + previous);
      service.importRecords(
        input([
          fact(previous, {
            event_id: "previous",
            occurred_at: "2026-11-04T09:00:00Z",
          }),
          fact("execution_completed", {
            event_id: "completed",
            occurred_at: "2026-11-04T09:01:00Z",
          }),
        ]),
      );
      expect(service.list().operations[0]!.delivery_state).toBe("unknown");
      expect(service.list().cases[0]!.kind).toBe("charge_unconfirmed");
    }
  });
});
