import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ConsoleService } from "../src/console/service.js";
import { consoleApp } from "../src/console/http.js";
import { createConsoleGateway } from "../src/console/gateway.js";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture() {
  const db = new Database(":memory:");
  cleanups.push(() => db.close());
  let now = new Date("2026-10-28T12:00:00Z");
  const service = new ConsoleService(db, randomUUID(), () => now);
  const session = service.initialize("Private demo");
  const a = service.agents()[0]!;
  const key = service.createKey({
    agent_id: a.id,
    name: "Test key",
    scopes: ["payments:read", "payments:write"],
  });
  return {
    db,
    service,
    session,
    a,
    key,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
const input = (amount = "12.50", key = "invoice_001") => ({
  idempotency_key: key,
  recipient: "dataco",
  amount,
  purpose: "Research invoice",
});
describe("agent payments control plane", () => {
  it("starts with actual empty records and protects private sessions", () => {
    const f = fixture();
    expect(f.service.snapshot().payments).toEqual([]);
    expect(f.service.snapshot().balance.available).toBe("10000.00");
    expect(() => f.service.checkOwner(f.session.secret)).not.toThrow();
    expect(() => f.service.checkOwner("incorrect")).toThrow();
    f.advance(8 * 86400000);
    expect(() => f.service.checkOwner(f.session.secret)).toThrow(/expired/);
  });
  it("stores only key hashes, applies scopes and revokes keys immediately", () => {
    const f = fixture(),
      key = f.service.createKey({
        agent_id: f.a.id,
        name: "Read only",
        scopes: ["payments:read"],
      });
    expect(JSON.stringify(f.service.snapshot())).not.toContain(key.key);
    expect(
      JSON.stringify(f.db.prepare("SELECT * FROM console_keys").all()),
    ).not.toContain(key.key);
    expect(() => f.service.authenticate(key.key, "payments:write")).toThrow(
      /requires/,
    );
    expect(f.service.authenticate(key.key, "payments:read").agent_id).toBe(
      f.a.id,
    );
    f.service.revokeKey(key.id);
    expect(() => f.service.authenticate(key.key, "payments:read")).toThrow(
      /revoked/,
    );
  });
  it("deduplicates concurrent requests and refuses changed payloads", async () => {
    const f = fixture();
    const p = await Promise.all([
      f.service.request(input(), f.a.id),
      f.service.request(input(), f.a.id),
    ]);
    expect(p[0]!.id).toBe(p[1]!.id);
    expect(f.service.payments()).toHaveLength(1);
    expect(
      (await f.service.request({ ...input(), amount: "12.5" }, f.a.id)).id,
    ).toBe(p[0]!.id);
    await expect(f.service.request(input("13.00"), f.a.id)).rejects.toThrow(
      /different/,
    );
  });
  it("reserves company budget across concurrent agents", async () => {
    const f = fixture();
    f.service.saveRules({
      per_payment: "100.00",
      daily: "100.00",
      approval_above: "50.00",
      merchants: ["dataco"],
    });
    const second = f.service.createAgent({
      name: "Second agent",
      per_payment: "100.00",
      daily: "500.00",
    });
    const p = await Promise.all([
      f.service.request(input("75.00", "a"), f.a.id),
      f.service.request(input("75.00", "b"), second.id),
    ]);
    expect(p.map((x) => x.status).sort()).toEqual([
      "denied",
      "pending_approval",
    ]);
    expect(f.service.snapshot().balance.reserved).toBe("75.00");
  });
  it("enforces the stricter agent budget and approved vendor list", async () => {
    const f = fixture();
    expect((await f.service.request(input("150.00"), f.a.id)).status).toBe(
      "denied",
    );
    f.service.saveRules({
      per_payment: "1000.00",
      daily: "2500.00",
      approval_above: "50.00",
      merchants: ["compute-co"],
    });
    expect(
      (await f.service.request(input("1.00", "blocked_vendor"), f.a.id)).status,
    ).toBe("denied");
    expect(f.service.reserved()).toBe(0);
  });
  it("reads never settle a payment; a worker tick settles exactly once with a balanced journal", async () => {
    const f = fixture(),
      p = await f.service.request(input(), f.a.id);
    f.advance(6000);
    expect(f.service.payment(p.id).status).toBe("queued");
    expect(f.service.snapshot().balance.total).toBe("10000.00");
    f.service.tick();
    expect(f.service.payment(p.id).status).toBe("completed");
    f.service.tick();
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) n,SUM(amount_minor) total FROM console_journal",
        )
        .get(),
    ).toEqual({ n: 2, total: 0 });
    expect(f.service.snapshot().balance.available).toBe("9987.50");
    expect(f.service.nextAlarm()).toBeNull();
  });
  it("keeps approval usable after quote expiry, prevents replay and releases rejected reservations", async () => {
    const f = fixture(),
      p = await f.service.request(input("75.00"), f.a.id);
    f.advance(360000);
    expect(f.service.decide(p.id, "approve").status).toBe("queued");
    expect(() => f.service.decide(p.id, "approve")).toThrow(/no longer/);
    f.advance(6000);
    f.service.tick();
    expect(f.service.payment(p.id).status).toBe("completed");
    const p2 = await f.service.request(input("75.00", "other"), f.a.id);
    expect(f.service.decide(p2.id, "reject").status).toBe("rejected");
    expect(f.service.reserved()).toBe(0);
  });
  it("expires approvals and releases budget without owner action", async () => {
    const f = fixture(),
      p = await f.service.request(input("75.00"), f.a.id);
    f.advance(900001);
    f.service.tick();
    expect(f.service.payment(p.id).status).toBe("expired");
    expect(f.service.reserved()).toBe(0);
  });
  it("rechecks policy at dispatch and never settles work over new hard limits", async () => {
    const f = fixture(),
      p = await f.service.request(input(), f.a.id);
    f.service.saveRules({
      per_payment: "5.00",
      daily: "2500.00",
      approval_above: "50.00",
      merchants: ["dataco"],
    });
    f.advance(6000);
    f.service.tick();
    expect(f.service.payment(p.id).status).toBe("denied");
    expect(f.service.balance()).toBe(1000000);
  });
  it("requires approval if the threshold changes while work is queued", async () => {
    const f = fixture(),
      p = await f.service.request(input(), f.a.id);
    f.service.saveRules({
      per_payment: "1000.00",
      daily: "2500.00",
      approval_above: "0.00",
      merchants: ["dataco"],
    });
    f.advance(6000);
    f.service.tick();
    expect(f.service.payment(p.id).status).toBe("pending_approval");
    expect(f.service.balance()).toBe(1000000);
  });
  it("rolls back both ledger postings and payment status if settlement fails", async () => {
    const f = fixture(),
      p = await f.service.request(input(), f.a.id);
    f.db.exec(
      "CREATE TRIGGER reject_credit BEFORE INSERT ON console_journal WHEN NEW.account != 'treasury' BEGIN SELECT RAISE(ABORT,'test fault'); END",
    );
    f.advance(6000);
    expect(() => f.service.tick()).toThrow();
    expect(f.service.payment(p.id).status).toBe("queued");
    expect(
      f.db.prepare("SELECT COUNT(*) n FROM console_journal").get(),
    ).toEqual({ n: 0 });
    expect(f.service.balance()).toBe(1000000);
  });
  it("persists records across a new service instance and keeps audit append-only", async () => {
    const f = fixture(),
      p = await f.service.request(input(), f.a.id);
    const again = new ConsoleService(f.db, f.service.workspaceId);
    expect(again.payment(p.id).id).toBe(p.id);
    expect(() => f.db.exec("DELETE FROM console_audit")).toThrow(/append-only/);
  });
});
describe("UTC budget rollover", () => {
  it("charges settlement to its UTC day and carries outstanding reservations across midnight", async () => {
    const f = fixture();
    f.service.saveRules({
      per_payment: "20.00",
      daily: "20.00",
      approval_above: "50.00",
      merchants: ["dataco"],
    });
    f.advance(12 * 3600000 - 2000);
    const p = await f.service.request(input(), f.a.id);
    f.advance(7000);
    f.service.tick();
    expect(f.service.payment(p.id).status).toBe("completed");
    expect(f.service.history().spent_today).toBe("12.50");
    expect(
      (await f.service.request(input("12.50", "next_day"), f.a.id)).status,
    ).toBe("denied");
  });
  it("keeps pending approvals reserved when the UTC day changes", async () => {
    const f = fixture();
    f.service.saveRules({
      per_payment: "100.00",
      daily: "100.00",
      approval_above: "50.00",
      merchants: ["dataco"],
    });
    f.advance(12 * 3600000 - 2000);
    await f.service.request(input("75.00"), f.a.id);
    f.advance(7000);
    expect(
      (await f.service.request(input("75.00", "next_day"), f.a.id)).status,
    ).toBe("denied");
    expect(f.service.history().spent_today).toBe("75.00");
  });
});
describe("HTTP boundaries", () => {
  it("agent keys cannot approve themselves or read other agents payments", async () => {
    const f = fixture(),
      app = consoleApp(f.service, "https://railgate-self.vercel.app");
    const p = await f.service.request(input("75.00"), f.a.id);
    const second = f.service.createAgent({
        name: "Second agent",
        per_payment: "100.00",
        daily: "500.00",
      }),
      key = f.service.createKey({
        agent_id: second.id,
        name: "Second key",
        scopes: ["payments:read", "payments:write"],
      });
    expect(
      (
        await app.request(`/console-api/payments/${p.id}/decision`, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + f.key.key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "approve" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/console-api/v1/payments/" + p.id, {
          headers: { Authorization: "Bearer " + key.key },
        })
      ).status,
    ).toBe(404);
    expect(
      await (
        await app.request("/console-api/v1/payments", {
          headers: { Authorization: "Bearer " + key.key },
        })
      ).json(),
    ).toMatchObject({ data: [] });
  });
  it("rejects owner CSRF and permits explicit same-origin decisions", async () => {
    const f = fixture(),
      app = consoleApp(f.service, "https://railgate-self.vercel.app"),
      p = await f.service.request(input("75.00"), f.a.id);
    const path = `/console-api/payments/${p.id}/decision`;
    const make = (origin: string) =>
      app.request(path, {
        method: "POST",
        headers: {
          Cookie: `rg_console=${f.session.id}.${f.session.secret}`,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "approve" }),
      });
    expect((await make("https://evil.example")).status).toBe(403);
    expect((await make("https://railgate-self.vercel.app")).status).toBe(200);
  });
  it("enforces write scope, schema validation and idempotency over HTTP", async () => {
    const f = fixture(),
      app = consoleApp(f.service, "https://railgate-self.vercel.app");
    const read = f.service.createKey({
      agent_id: f.a.id,
      name: "Read key",
      scopes: ["payments:read"],
    });
    const post = (body: unknown, key = f.key.key) =>
      app.request("/console-api/v1/payments", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect((await post(input(), read.key)).status).toBe(403);
    expect((await post({ ...input(), agent_id: randomUUID() })).status).toBe(
      400,
    );
    expect((await post(input())).status).toBe(202);
    expect((await post(input("15.00"))).status).toBe(409);
  });
  it("gateway only forwards console cookies, paths and safe response headers", async () => {
    const calls: Request[] = [];
    const gateway = createConsoleGateway(async (i, o) => {
      calls.push(new Request(i, o));
      return Response.json(
        { ok: true },
        {
          headers: {
            "Set-Cookie":
              "rg_console=demo; HttpOnly; Secure; SameSite=Strict; Path=/console-api",
            "X-Internal-Secret": "never-forward",
          },
        },
      );
    });
    const r = await gateway(
      new Request("https://site.example/console-api/session", {
        headers: { Cookie: "rg_console=demo", Authorization: "Bearer limited" },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
    expect(r.headers.has("x-internal-secret")).toBe(false);
    expect(calls[0]!.url).toBe(
      "https://railgate-console.33fazirana.workers.dev/console-api/session",
    );
    expect(
      (await gateway(new Request("https://site.example/owner/activate")))
        .status,
    ).toBe(404);
  });
});
