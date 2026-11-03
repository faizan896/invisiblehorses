import { describe, expect, it, vi } from "vitest";
import { canonicalInputHash, HttpToolProvider, SandboxToolProvider, type Quote } from "../src/tool-gate/provider.js";

const now = new Date("2030-01-01T00:00:00.000Z");
const clock = () => now;
const input = { query: "Company research" };
const inputHash = canonicalInputHash(input);
const secret = "server-only-provider-token";
const quote = (extra: Record<string, unknown> = {}) => ({
  id: "quote-1", amount_minor: 25, currency: "USD", input_hash: inputHash,
  expires_at: "2030-01-01T00:05:00.000Z", ...extra,
});
const outcome = (extra: Record<string, unknown> = {}) => ({
  state: "confirmed", request_id: "request-1", provider_request_id: "provider-1",
  quote_id: "quote-1", input_hash: inputHash, currency: "USD", amount_minor: 25,
  result: { report: "Purchased resource" }, ...extra,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
function provider(fetcher: typeof fetch) {
  return new HttpToolProvider({ id: "fixed-data", origin: "https://provider.example", secret, fetcher, clock });
}

describe("fixed-price HTTP tool provider", () => {
  it("uses only configured routes, backend auth and the stable provider idempotency key", async () => {
    const calls: { url: string; options?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return json(quote());
      return json(outcome());
    };
    const adapter = provider(fetcher);
    const q = await adapter.quote(input, inputHash);
    await adapter.execute(q, "request-1", input);
    await adapter.reconcile("request-1");
    expect(calls.map(x => x.url)).toEqual([
      "https://provider.example/quotes", "https://provider.example/executions", "https://provider.example/executions/request-1",
    ]);
    expect(calls.map(x => x.options?.method)).toEqual(["POST", "POST", "GET"]);
    expect(calls.every(x => x.options?.redirect === "error" && x.options.credentials === "omit")).toBe(true);
    expect(new Headers(calls[0]!.options!.headers).get("Authorization")).toBe("Bearer " + secret);
    expect(new Headers(calls[1]!.options!.headers).get("Idempotency-Key")).toBe("request-1");
    expect(JSON.parse(calls[0]!.options!.body as string)).toEqual({ input, input_hash: inputHash });
    expect(JSON.parse(calls[1]!.options!.body as string)).toEqual({ quote_id: q.id, request_id: "request-1", input });
    expect(JSON.stringify(adapter)).not.toContain(secret);
  });

  it.each([
    "http://provider.example", "https://localhost", "https://127.0.0.1",
    "https://[::1]", "https://provider.example/execute", "https://user:pass@provider.example",
    "https://provider.example?key=x", "https://provider.example#fragment",
  ])("rejects an unsafe configured origin: %s", origin => {
    expect(() => new HttpToolProvider({ id: "fixed-data", origin, secret })).toThrow(/HTTPS/);
  });

  it("does not turn an agent-supplied URL into a network destination", async () => {
    const malicious = { url: "https://attacker.example/steal", headers: { authorization: "fake" } };
    const fetcher = vi.fn<typeof fetch>(async () => json(quote({ input_hash: canonicalInputHash(malicious) })));
    await provider(fetcher).quote(malicious, canonicalInputHash(malicious));
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://provider.example/quotes");
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("Authorization")).toBe("Bearer " + secret);
  });

  it.each([
    { currency: "EUR" }, { amount_minor: -1 }, { amount_minor: 1.25 },
    { amount_minor: Number.MAX_SAFE_INTEGER + 1 }, { id: "../quote" },
    { input_hash: "a".repeat(64) }, { expires_at: "not-a-date" },
    { expires_at: "2029-12-31T23:59:59.000Z" }, { extra_field: true },
  ])("rejects malformed or unbound quotes: %j", async changes => {
    await expect(provider(async () => json(quote(changes))).quote(input, inputHash)).rejects.toThrow();
  });

  it("refuses a changed input or hash before contacting the provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = provider(fetcher);
    await expect(adapter.quote(input, "b".repeat(64))).rejects.toThrow(/fingerprint/);
    await expect(adapter.execute(quote() as Quote, "request-1", { query: "Different purchase" })).rejects.toThrow(/changed/);
    await expect(adapter.reconcile("../steal")).rejects.toThrow(/identifier/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { request_id: "wrong-request" }, { quote_id: "wrong-quote" },
    { input_hash: "b".repeat(64) }, { currency: "EUR" },
    { provider_request_id: "" }, { amount_minor: 26 }, { amount_minor: -1 },
    { amount_minor: .5 }, { amount_minor: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects a mismatched or invalid execution receipt: %j", async changes => {
    await expect(provider(async () => json(outcome(changes))).execute(quote() as Quote, "request-1", input)).rejects.toThrow();
  });

  it("requires a definite zero charge before accepting a failure receipt", async () => {
    const adapter = provider(async () => json(outcome({ state: "failed", amount_minor: 0, result: undefined })));
    expect((await adapter.reconcile("request-1")).state).toBe("failed");
    for (const amount_minor of [undefined, 1]) {
      await expect(provider(async () => json(outcome({ state: "failed", amount_minor }))).reconcile("request-1")).rejects.toThrow();
    }
  });

  it("keeps HTTP404 reconciliation unknown without fabricating receipt identifiers", async () => {
    const adapter = provider(async () => new Response(null, { status: 404 }));
    expect(await adapter.reconcile("request-1")).toEqual({
      state: "pending", request_id: "request-1", reason: expect.any(String),
    });
    await expect(adapter.execute(quote() as Quote, "request-1", input)).rejects.toThrow(/not confirmed/);
  });

  it("never follows redirect responses or discloses their response body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(secret, {
      status: 302, headers: { Location: "https://attacker.example/" },
    }));
    await expect(provider(fetcher).quote(input, inputHash)).rejects.toThrow("HTTP 302");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe("error");
  });

  it("bounds both advertised and streamed JSON bodies and cancels oversized streams", async () => {
    await expect(provider(async () => new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "262145" },
    })).quote(input, inputHash)).rejects.toThrow(/bounded JSON/);
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(262145)); },
      cancel: cancelled,
    });
    await expect(provider(async () => new Response(stream, {
      headers: { "content-type": "application/json" },
    })).quote(input, inputHash)).rejects.toThrow(/256 KiB/);
    expect(cancelled).toHaveBeenCalled();
  });

  it("does not leak backend credentials through errors, quoted IDs or provider output", async () => {
    const transport = provider(async () => { throw new Error("Private credential: " + secret); });
    const transportError = await transport.quote(input, inputHash).catch(e => e as Error);
    expect(String(transportError)).not.toContain(secret);
    for (const body of [
      outcome({ reason: "Credential " + secret }),
      outcome({ result: { nested: secret } }),
      quote({ id: secret }),
    ]) {
      const adapter = provider(async () => json(body));
      const error = "state" in body
        ? await adapter.reconcile("request-1").catch(e => e as Error)
        : await adapter.quote(input, inputHash).catch(e => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
    }
    expect(() => new HttpToolProvider({ id: "x", origin: "https://provider.example", secret: "bad\ncredential" })).toThrow();
  });
});

describe("sandbox provider fixture", () => {
  it("counts one fixture charge and independently reads a cloned receipt for the same request", async () => {
    const adapter = new SandboxToolProvider({ id: "data", amount_minor: 35, clock });
    const q = await adapter.quote(input, inputHash);
    const [a, b] = await Promise.all([adapter.execute(q, "request-1", input), adapter.execute(q, "request-1", input)]);
    expect(a).toEqual(b);
    expect(adapter.executionCount).toBe(1);
    expect(a.state).toBe("confirmed");
    if (a.state === "confirmed") {
      expect(a.amount_minor).toBe(35);
      expect(a.result).toMatchObject({ kind: "sandbox_fixture", note: expect.stringContaining("No bank or crypto") });
      a.provider_request_id = "tampered";
    }
    expect((await adapter.reconcile("request-1")).provider_request_id).not.toBe("tampered");
    await expect(adapter.execute(q, "another-request", input)).rejects.toThrow(/consumed/);
  });

  it("refuses idempotency conflicts, altered inputs and forged quote values", async () => {
    const adapter = new SandboxToolProvider({ clock });
    const q = await adapter.quote(input, inputHash);
    await adapter.execute(q, "request-1", input);
    const second = await adapter.quote(input, inputHash);
    await expect(adapter.execute(second, "request-1", input)).rejects.toThrow(/idempotency/);
    await expect(adapter.execute({ ...q, amount_minor: 1 }, "request-2", input)).rejects.toThrow(/quote/);
    await expect(adapter.execute(q, "request-2", { query: "Changed" })).rejects.toThrow(/quote/);
  });

  it("returns pending after fixture restart and never claims an external payment receipt", async () => {
    const first = new SandboxToolProvider({ clock });
    const q = await first.quote(input, inputHash);
    await first.execute(q, "request-1", input);
    const restarted = new SandboxToolProvider({ clock });
    expect(restarted.mode).toBe("sandbox");
    expect((await restarted.reconcile("request-1")).state).toBe("pending");
    await expect(restarted.execute(q, "request-1", input)).rejects.toThrow(/quote/);
    expect(restarted.executionCount).toBe(0);
  });

  it("blocks new execution after expiry but permits a cached replay without another charge", async () => {
    let instant = now;
    const adapter = new SandboxToolProvider({ clock: () => instant, quoteLifetimeMs: 1000 });
    const executed = await adapter.quote(input, inputHash);
    const expired = await adapter.quote(input, inputHash);
    await adapter.execute(executed, "request-1", input);
    instant = new Date(now.getTime() + 2000);
    await expect(adapter.execute(expired, "request-2", input)).rejects.toThrow(/expired/);
    expect((await adapter.execute(executed, "request-1", input)).state).toBe("confirmed");
    expect(adapter.executionCount).toBe(1);
  });
});

describe("canonical tool input fingerprints", () => {
  it("uses stable nested JSON key ordering and distinguishes changed values", () => {
    expect(canonicalInputHash({ b: [2, { z: true, a: null }], a: 1 })).toBe(canonicalInputHash({ a: 1, b: [2, { a: null, z: true }] }));
    expect(canonicalInputHash({ a: 1 })).not.toBe(canonicalInputHash({ a: 2 }));
  });
  it("rejects non-JSON values, cycles, accessors, oversized and overly deep inputs", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const getter = Object.defineProperty({}, "x", { enumerable: true, get() { throw new Error("Getter ran"); } });
    let deep: unknown = 1; for (let n = 0; n < 35; n++) deep = [deep];
    for (const value of [undefined, NaN, Infinity, 1n, new Date(), cyclic, getter, new Array(2), { x: "a".repeat(65537) }, deep])
      expect(() => canonicalInputHash(value)).toThrow();
  });
});
