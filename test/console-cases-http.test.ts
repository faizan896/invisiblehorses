import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ConsoleService } from "../src/console/service.js";
import { consoleApp } from "../src/console/http.js";
import { createConsoleGateway } from "../src/console/gateway.js";
import type { CasesSnapshot } from "../src/cases/model.js";

const origin = "https://invisiblehorses.vercel.app";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const db = new Database(":memory:");
  cleanups.push(() => db.close());
  const service = new ConsoleService(
    db,
    randomUUID(),
    () => new Date("2026-11-04T12:00:00Z"),
  );
  const session = service.initialize("Cases workspace");
  const agent = service.agents()[0]!;
  const key = service.createKey({
    agent_id: agent.id,
    name: "Agent credential",
    scopes: ["payments:read", "payments:write"],
  });
  const app = consoleApp(service, origin);
  const cookie = `rg_console=${session.id}.${session.secret}`;
  const headers = {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/json",
  };
  return {
    db,
    service,
    session,
    key,
    app,
    cookie,
    headers,
    post: (path: string, body: unknown) =>
      app.request("/console-api/cases" + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    get: (path = "") =>
      app.request("/console-api/cases" + path, {
        headers: { Cookie: cookie },
      }),
  };
}
const event = (overrides: Record<string, unknown> = {}) => ({
  event_id: "evt_charge",
  operation_id: "op_research",
  job_id: "job_research",
  customer_id: "customer_acme",
  provider: "custom",
  provider_ref: "request_research",
  unit: "usd_cent",
  kind: "charge_reported",
  amount_minor: 1250,
  occurred_at: "2026-11-04T10:00:00Z",
  ...overrides,
});
const batch = (...events: ReturnType<typeof event>[]) => ({
  format: "normalized",
  events,
});

describe("Cases owner API boundaries", () => {
  it("requires an owner session for reads, exports and imports; agent credentials grant no case access", async () => {
    const f = fixture();
    for (const path of ["", "/export"]) {
      const url = "/console-api/cases" + path;
      expect((await f.app.request(url)).status).toBe(401);
      expect(
        (
          await f.app.request(url, {
            headers: { Authorization: "Bearer " + f.key.key },
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await f.app.request("/console-api/cases/import", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + f.key.key,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(batch(event())),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.app.request("/console-api/v1/cases", {
          headers: { Authorization: "Bearer " + f.key.key },
        })
      ).status,
    ).toBe(404);
    expect((await f.get()).status).toBe(200);
  });

  it("rejects missing and foreign origins before changing owner records", async () => {
    const f = fixture();
    for (const path of ["/import", "/demo"]) {
      for (const requestOrigin of [undefined, "https://untrusted.example"]) {
        const headers: Record<string, string> = {
          Cookie: f.cookie,
          "Content-Type": "application/json",
        };
        if (requestOrigin) headers.Origin = requestOrigin;
        const response = await f.app.request("/console-api/cases" + path, {
          method: "POST",
          headers,
          body: JSON.stringify(path === "/import" ? batch(event()) : {}),
        });
        expect(response.status).toBe(403);
      }
    }
    expect(await (await f.get()).json()).toMatchObject({ operations: [] });
    expect((await f.post("/import", batch(event()))).status).toBe(200);
  });

  it("keeps workspace records inaccessible to a different workspace session", async () => {
    const first = fixture();
    const second = fixture();
    expect((await first.post("/import", batch(event()))).status).toBe(200);
    expect(await (await second.get()).json()).toMatchObject({ operations: [] });
    const wrongSession = await first.app.request("/console-api/cases", {
      headers: { Cookie: second.cookie },
    });
    expect(wrongSession.status).toBe(401);
    const saved = (await (await first.get()).json()) as {
      operations: unknown[];
    };
    expect(saved.operations).toHaveLength(1);
  });

  it("rejects malformed JSON, oversized imports and forged evidence labels without saving facts", async () => {
    const f = fixture();
    expect(
      (
        await f.app.request("/console-api/cases/import", {
          method: "POST",
          headers: f.headers,
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.post("/import", batch(event({ source: "provider_verified" }))))
        .status,
    ).toBe(400);
    expect(
      (
        await f.app.request("/console-api/cases/import", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({
            format: "normalized",
            events: [],
            padding: "x".repeat(1048600),
          }),
        })
      ).status,
    ).toBe(413);
    expect(await (await f.get()).json()).toMatchObject({ operations: [] });
    const legacy = await f.app.request("/console-api/v1/payments", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + f.key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ purpose: "x".repeat(17000) }),
    });
    expect(legacy.status).toBe(413);
  });

  it("imports a batch atomically and refuses changed content under a saved event ID", async () => {
    const f = fixture();
    expect(
      (
        await f.post(
          "/import",
          batch(event(), event({ event_id: "evt_invalid", amount_minor: -1 })),
        )
      ).status,
    ).toBe(400);
    expect(await (await f.get()).json()).toMatchObject({ operations: [] });
    const first = await f.post("/import", batch(event()));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ added: 1, duplicates: 0 });
    const repeated = await f.post("/import", batch(event()));
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ added: 0, duplicates: 1 });
    expect(
      (await f.post("/import", batch(event({ amount_minor: 1300 })))).status,
    ).toBe(409);
    const saved = (await (await f.get()).json()) as { operations: unknown[] };
    expect(saved.operations).toHaveLength(1);
  });

  it("loads explicit demo records idempotently without touching payment balances, queues or credentials", async () => {
    const f = fixture();
    const before = f.service.snapshot();
    expect((await f.post("/demo", { unexpected: true })).status).toBe(400);
    expect((await f.post("/demo", {})).status).toBe(200);
    const once = (await (await f.get()).json()) as {
      mode: string;
      operations: unknown[];
    };
    expect(once.mode).toBe("read_only");
    expect(once.operations.length).toBeGreaterThan(0);
    expect((await f.post("/demo", {})).status).toBe(200);
    const twice = (await (await f.get()).json()) as { operations: unknown[] };
    expect(twice.operations).toHaveLength(once.operations.length);
    expect(f.service.snapshot().balance).toEqual(before.balance);
    expect(f.service.snapshot().payments).toEqual([]);
    expect(f.service.nextAlarm()).toBeNull();
    const exported = await f.get("/export");
    expect(exported.status).toBe(200);
    expect(exported.headers.get("Content-Disposition")).toContain("attachment");
    expect(exported.headers.get("Cache-Control")).toBe("no-store");
    const serialized = await exported.text();
    expect(serialized).not.toContain(f.session.secret);
    expect(serialized).not.toContain(f.session.recovery_code);
    expect(serialized).not.toContain(f.key.key);
    expect(serialized).not.toContain("secret_hash");
  });

  it("serves a persisted import through a fresh application instance without claiming provider verification", async () => {
    const f = fixture();
    expect((await f.post("/import", batch(event()))).status).toBe(200);
    const fresh = consoleApp(
      new ConsoleService(
        f.db,
        f.service.workspaceId,
        () => new Date("2026-11-04T12:00:00Z"),
      ),
      origin,
    );
    const response = await fresh.request("/console-api/cases/export", {
      headers: { Cookie: f.cookie },
    });
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expect(serialized).toContain("evt_charge");
    const snapshot = await fresh.request("/console-api/cases", {
      headers: { Cookie: f.cookie },
    });
    expect(await snapshot.text()).toContain("imported_unverified");
    expect(serialized).not.toContain("received_at");
    expect(serialized).not.toContain("provider_verified");
    expect(serialized).not.toContain(f.key.key);
    const payload = JSON.parse(serialized);
    expect(Object.keys(payload).sort()).toEqual(["events", "format"]);
    expect(payload.format).toBe("normalized");
    const replay = await f.post("/import", payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ added: 0, duplicates: 1 });
  });

  it("keeps a refund request pending until an imported refund fact is received", async () => {
    const f = fixture();
    const input = batch(
      event(),
      event({
        event_id: "evt_result",
        kind: "result_delivered",
        amount_minor: undefined,
        occurred_at: "2026-11-04T10:01:00Z",
      }),
      event({
        event_id: "evt_refund_request",
        kind: "refund_requested",
        amount_minor: undefined,
        occurred_at: "2026-11-04T10:02:00Z",
      }),
    );
    expect((await f.post("/import", input)).status).toBe(200);
    const pending = (await (await f.get()).json()) as CasesSnapshot;
    expect(pending.operations[0]!.charge_state).toBe("refund_requested");
    expect(pending.operations[0]!.delivery_state).toBe("reported_delivered");
    expect(pending.cases.map((item) => item.kind)).toContain("refund_pending");
    expect(
      (
        await f.post(
          "/import",
          batch(
            event({
              event_id: "evt_refund_report",
              kind: "refund_reported",
              amount_minor: 1250,
              occurred_at: "2026-11-04T10:03:00Z",
            }),
          ),
        )
      ).status,
    ).toBe(200);
    const refunded = (await (await f.get()).json()) as CasesSnapshot;
    expect(refunded.operations[0]!.charge_state).toBe("reported_refunded");
    expect(refunded.operations[0]!.source).toBe("imported_unverified");
    expect(refunded.cases.map((item) => item.kind)).not.toContain(
      "refund_pending",
    );
    expect(f.service.snapshot().balance.total).toBe("10000.00");
  });
});

describe("Cases gateway boundaries", () => {
  it("forwards only the supported Cases routes and preserves download headers", async () => {
    const calls: Request[] = [];
    const gateway = createConsoleGateway(async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json(
        { mode: "read_only" },
        {
          headers: {
            "Content-Disposition": 'attachment; filename="cases-evidence.json"',
            "X-Provider-Secret": "never-forward",
          },
        },
      );
    });
    for (const path of ["", "/export"]) {
      const response = await gateway(
        new Request("https://site.example/console-api/cases" + path),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Disposition")).toContain(
        "cases-evidence",
      );
      expect(response.headers.has("X-Provider-Secret")).toBe(false);
    }
    for (const path of ["/import", "/demo"]) {
      expect(
        (
          await gateway(
            new Request("https://site.example/console-api/cases" + path, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            }),
          )
        ).status,
      ).toBe(200);
    }
    expect(calls).toHaveLength(4);
    expect(calls[0]!.url).toBe(
      "https://railgate-console.33fazirana.workers.dev/console-api/cases",
    );
    expect(
      (
        await gateway(
          new Request("https://site.example/console-api/cases/delete"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await gateway(
          new Request("https://site.example/console-api/cases", {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(405);
    expect(calls).toHaveLength(4);
  });

  it("permits bounded Cases imports while retaining the smaller payment body limit", async () => {
    const calls: Request[] = [];
    const gateway = createConsoleGateway(async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ ok: true });
    });
    const post = (path: string, size: number) =>
      gateway(
        new Request("https://site.example/console-api/" + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ padding: "x".repeat(size) }),
        }),
      );
    expect((await post("cases/import", 20000)).status).toBe(200);
    expect((await post("cases/import", 1048600)).status).toBe(413);
    expect((await post("v1/payments", 20000)).status).toBe(413);
    expect(calls).toHaveLength(1);
  });
});
