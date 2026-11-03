import Database from "better-sqlite3";
import { describe, it, expect, afterEach } from "vitest";
import { GateService } from "../src/tool-gate/service.js";
import { SandboxToolProvider } from "../src/tool-gate/provider.js";
import { toolGateApp } from "../src/tool-gate/http.js";

const owner = "test_owner_" + "x".repeat(40);
const databases: Database.Database[] = [];
const json = (value: unknown) => JSON.stringify(value);
const headers = (token: string) => ({
  Authorization: "Bearer " + token,
  "Content-Type": "application/json",
});
function setup(approval = 100) {
  const db = new Database(":memory:");
  databases.push(db);
  const provider = new SandboxToolProvider({ id: "search", amount_minor: 25 });
  const service = new GateService(db, [provider], {
    daily_limit_minor: 1000,
    per_request_limit_minor: 500,
    approval_above_minor: approval,
  });
  return { service, app: toolGateApp(service, owner) };
}
async function identities(
  app: ReturnType<typeof toolGateApp>,
  customer = "acme",
) {
  const response = await app.request("/owner/agents", {
    method: "POST",
    headers: headers(owner),
    body: json({
      customer_id: customer,
      name: "Research",
      per_request_limit_minor: 100,
      daily_limit_minor: 500,
    }),
  });
  expect(response.status).toBe(201);
  const identity = (await response.json()) as {
    agent: { id: string; key_id: string };
    key: string;
  };
  const jobResponse = await app.request("/owner/jobs", {
    method: "POST",
    headers: headers(owner),
    body: json({
      customer_id: customer,
      name: "Research job",
      budget_minor: 200,
      agent_ids: [identity.agent.id],
      tool_ids: ["search"],
    }),
  });
  expect(jobResponse.status).toBe(201);
  const job = (await jobResponse.json()) as { id: string };
  return { ...identity, job };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe("company tool gate HTTP boundary", () => {
  it("keeps owner, agent and cross-customer permissions separate", async () => {
    const { app } = setup();
    const a = await identities(app);
    const b = await identities(app, "other");
    expect((await app.request("/owner/summary")).status).toBe(401);
    expect(
      (await app.request("/owner/summary", { headers: headers(a.key) })).status,
    ).toBe(401);
    expect(
      (await app.request("/v1/requests", { headers: headers(owner) })).status,
    ).toBe(401);
    const denied = await app.request("/v1/requests", {
      method: "POST",
      headers: headers(b.key),
      body: json({
        job_id: a.job.id,
        tool_id: "search",
        input: { q: "supplier" },
        idempotency_key: "cross",
      }),
    });
    expect(denied.status).toBe(404);
  });
  it("GET reads do not execute work and receipts identify sandbox evidence", async () => {
    const { app, service } = setup();
    const a = await identities(app);
    const b = await identities(app, "other");
    const response = await app.request("/v1/requests", {
      method: "POST",
      headers: headers(a.key),
      body: json({
        job_id: a.job.id,
        tool_id: "search",
        input: { q: "supplier" },
        idempotency_key: "invoice-1",
      }),
    });
    expect(response.status).toBe(202);
    const saved = (await response.json()) as { id: string; status: string };
    expect(saved.status).toBe("queued");
    const get = await app.request("/v1/requests/" + saved.id, {
      headers: headers(a.key),
    });
    expect((await get.json()).status).toBe("queued");
    expect(get.headers.get("Cache-Control")).toBe("no-store");
    expect(
      (
        await app.request("/v1/requests/" + saved.id, {
          headers: headers(b.key),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/v1/requests/" + saved.id + "/receipt", {
          headers: headers(a.key),
        })
      ).status,
    ).toBe(409);
    await service.tick();
    const receipt = await app.request("/v1/requests/" + saved.id + "/receipt", {
      headers: headers(a.key),
    });
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({
      verification: "sandbox_fixture",
      provider_reported_charge: false,
      external_payment: false,
      bank_settlement_verified: false,
      actual_amount_minor: 25,
    });
    const summary = await app.request("/owner/summary", {
      headers: headers(owner),
    });
    const body = await summary.text();
    expect(body).not.toContain(a.key);
    expect(body).not.toContain(owner);
  });
  it("requires owner approval and blocks revoked agent keys", async () => {
    const { app, service } = setup(0);
    const a = await identities(app);
    const response = await app.request("/v1/requests", {
      method: "POST",
      headers: headers(a.key),
      body: json({
        job_id: a.job.id,
        tool_id: "search",
        input: { q: "supplier" },
        idempotency_key: "approve-1",
      }),
    });
    const saved = (await response.json()) as { id: string; status: string };
    expect(saved.status).toBe("pending_approval");
    await service.tick();
    expect(service.getRequest(saved.id).status).toBe("pending_approval");
    expect(
      (
        await app.request("/owner/requests/" + saved.id + "/approve", {
          method: "POST",
          headers: headers(a.key),
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/owner/requests/" + saved.id + "/approve", {
          method: "POST",
          headers: headers(owner),
          body: "{}",
        })
      ).status,
    ).toBe(200);
    await service.tick();
    expect(service.getRequest(saved.id).status).toBe("confirmed");
    expect(
      (
        await app.request("/owner/keys/" + a.agent.key_id + "/revoke", {
          method: "POST",
          headers: headers(owner),
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect(
      (await app.request("/v1/requests", { headers: headers(a.key) })).status,
    ).toBe(401);
  });
  it("rejects conflicting retries, invalid bodies and oversized inputs", async () => {
    const { app } = setup();
    const a = await identities(app);
    const payload = {
      job_id: a.job.id,
      tool_id: "search",
      input: { q: "first" },
      idempotency_key: "retry-1",
    };
    expect(
      (
        await app.request("/v1/requests", {
          method: "POST",
          headers: headers(a.key),
          body: json(payload),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await app.request("/v1/requests", {
          method: "POST",
          headers: headers(a.key),
          body: json({ ...payload, input: { q: "changed" } }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request("/v1/requests", {
          method: "POST",
          headers: headers(a.key),
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/owner/agents", {
          method: "POST",
          headers: headers(owner),
          body: json({ junk: true }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/requests", {
          method: "POST",
          headers: headers(a.key),
          body: json({ ...payload, input: { q: "x".repeat(70000) } }),
        })
      ).status,
    ).toBe(413);
  });
});
