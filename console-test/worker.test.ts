import { afterEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "railgate-console-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const start = async () => {
    const mf = new Miniflare({
      name: "console-test",
      modules: [
        {
          type: "ESModule",
          path: resolve("worker-dist/console/worker.js"),
          contents: readFileSync("worker-dist/console/worker.js", "utf8"),
        },
      ],
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        WORKSPACES: { className: "ConsoleWorkspace", useSQLite: true },
        GATE: { className: "ConsoleGate", useSQLite: true },
      },
      durableObjectsPersist: dir,
      bindings: { PUBLIC_ORIGIN: "https://railgate-self.vercel.app" },
    });
    await mf.ready;
    return mf;
  };
  let mf = await start();
  cleanup.push(() => mf.dispose());
  const request = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    mf.dispatchFetch("https://console.test/console-api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: "https://railgate-self.vercel.app",
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const create = async () => {
    const r = await request("/workspaces", { name: "Runtime test" });
    expect(r.status, await r.clone().text()).toBe(201);
    expect(r.headers.get("set-cookie")).toMatch(
      /HttpOnly; Secure; SameSite=Strict/,
    );
    return r.headers.get("set-cookie")!.split(";")[0]!;
  };
  return {
    request,
    create,
    restart: async () => {
      await mf.dispose();
      mf = await start();
    },
  };
}
describe("console in the actual Cloudflare runtime", () => {
  it("isolates owner sessions and agent payments between workspaces", async () => {
    const f = await setup(),
      one = await f.create(),
      two = await f.create();
    const a = (await (
      await f.request("/session", undefined, { Cookie: one })
    ).json()) as { workspace: { id: string }; agents: { id: string }[] };
    const b = (await (
      await f.request("/session", undefined, { Cookie: two })
    ).json()) as { workspace: { id: string }; payments: unknown[] };
    expect(a.workspace.id).not.toBe(b.workspace.id);
    expect(b.payments).toEqual([]);
    const key = (await (
      await f.request(
        "/keys",
        {
          agent_id: a.agents[0]!.id,
          name: "Runtime key",
          scopes: ["payments:read", "payments:write"],
        },
        { Cookie: one },
      )
    ).json()) as { key: string };
    const p = (await (
      await f.request(
        "/v1/payments",
        {
          idempotency_key: "isolated_001",
          recipient: "dataco",
          amount: "12.50",
          purpose: "Runtime invoice",
        },
        { Authorization: "Bearer " + key.key },
      )
    ).json()) as { status: string };
    expect(p.status).toBe("queued");
    expect(
      (
        (await (
          await f.request("/session", undefined, { Cookie: two })
        ).json()) as { payments: unknown[] }
      ).payments,
    ).toEqual([]);
    expect(
      (
        await f.request(
          "/rules",
          { per_payment: "1.00" },
          { Authorization: "Bearer " + key.key },
        )
      ).status,
    ).toBe(401);
  });
  it("executes a durable alarm without reads or browser polling and retains state across runtime restart", async () => {
    const f = await setup(),
      cookie = await f.create();
    const snapshot = (await (
      await f.request("/session", undefined, { Cookie: cookie })
    ).json()) as { agents: { id: string }[] };
    const key = (await (
      await f.request(
        "/keys",
        {
          agent_id: snapshot.agents[0]!.id,
          name: "Background key",
          scopes: ["payments:read", "payments:write"],
        },
        { Cookie: cookie },
      )
    ).json()) as { key: string };
    const input = {
      idempotency_key: "durable_001",
      recipient: "dataco",
      amount: "12.50",
      purpose: "No polling during settlement",
    };
    const p = (await (
      await f.request("/v1/payments", input, {
        Authorization: "Bearer " + key.key,
      })
    ).json()) as { id: string; status: string };
    expect(p.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 6500));
    await f.restart();
    const record = (await (
      await f.request("/v1/payments/" + p.id, undefined, {
        Authorization: "Bearer " + key.key,
      })
    ).json()) as { status: string };
    expect(record.status).toBe("completed");
    const replay = (await (
      await f.request("/v1/payments", input, {
        Authorization: "Bearer " + key.key,
      })
    ).json()) as { id: string };
    expect(replay.id).toBe(p.id);
    const state = (await (
      await f.request("/session", undefined, { Cookie: cookie })
    ).json()) as {
      balance: { total: string };
      worker: { next_run_at: string | null };
      payments: unknown[];
    };
    expect(state.balance.total).toBe("9987.50");
    expect(state.worker.next_run_at).toBeNull();
    expect(state.payments).toHaveLength(1);
  });
});
