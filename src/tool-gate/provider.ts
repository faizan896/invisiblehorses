import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Minor = z.number().nonnegative().refine(Number.isSafeInteger, "Use safe integer cents");
const QuoteSchema = z.strictObject({
  id: Identifier, amount_minor: Minor, currency: z.literal("USD"),
  input_hash: Hash, expires_at: z.iso.datetime({ offset: true }),
});
const BoundOutcome = {
  request_id: Identifier, provider_request_id: Identifier, quote_id: Identifier,
  input_hash: Hash, currency: z.literal("USD"), amount_minor: Minor.optional(),
  result: z.json().optional(), reason: z.string().max(500).optional(),
};
const OutcomeSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("confirmed"), ...BoundOutcome, amount_minor: Minor }),
  z.strictObject({ state: z.literal("failed"), ...BoundOutcome, amount_minor: z.literal(0) }),
  z.strictObject({
    state: z.literal("pending"), request_id: Identifier,
    provider_request_id: Identifier.optional(), quote_id: Identifier.optional(),
    input_hash: Hash.optional(), currency: z.literal("USD").optional(),
    amount_minor: Minor.optional(), reason: z.string().max(500).optional(),
  }),
]);

export type Quote = z.infer<typeof QuoteSchema>;
type ReceiptBinding = {
  request_id: string; provider_request_id: string; quote_id: string;
  input_hash: string; currency: "USD"; amount_minor?: number; result?: unknown; reason?: string;
};
export type Outcome =
  | ({ state: "confirmed"; amount_minor: number } & ReceiptBinding)
  | ({ state: "failed"; amount_minor: 0 } & ReceiptBinding)
  | { state: "pending"; request_id: string; provider_request_id?: string; quote_id?: string;
      input_hash?: string; currency?: "USD"; amount_minor?: number; reason?: string };
export interface ProviderAdapter {
  readonly id: string;
  readonly mode: "sandbox" | "external";
  quote(input: unknown, inputHash: string): Promise<Quote>;
  execute(quote: Quote, requestId: string, input: unknown): Promise<Outcome>;
  reconcile(requestId: string): Promise<Outcome>;
}

/** Deliberately excludes remote response bodies, credentials and transport errors. */
export class ProviderError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderError"; }
}

function canonicalInput(value: unknown): string {
  let nodes = 0;
  const active = new WeakSet<object>();
  function visit(item: unknown, depth: number): string {
    if (++nodes > 10000 || depth > 32) throw new ProviderError("Tool input is too complex");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || !item) throw new ProviderError("Tool input must contain JSON values");
    if (active.has(item)) throw new ProviderError("Tool input must not contain cycles");
    active.add(item);
    let result: string;
    if (Array.isArray(item)) {
      const parts: string[] = [];
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) throw new ProviderError("Tool input must not contain sparse arrays");
        parts.push(visit(item[i], depth + 1));
      }
      result = "[" + parts.join(",") + "]";
    } else {
      const prototype = Object.getPrototypeOf(item);
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(item).length)
        throw new ProviderError("Tool input must contain plain JSON objects");
      result = "{" + Object.keys(item).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (descriptor.get || descriptor.set) throw new ProviderError("Tool input must not contain accessors");
        return JSON.stringify(key) + ":" + visit(descriptor.value, depth + 1);
      }).join(",") + "}";
    }
    active.delete(item);
    return result;
  }
  const encoded = visit(value, 0);
  if (Buffer.byteLength(encoded) > 65536) throw new ProviderError("Tool input exceeds 64 KiB");
  return encoded;
}
export function canonicalInputHash(input: unknown) {
  return createHash("sha256").update(canonicalInput(input)).digest("hex");
}

function validQuote(input: unknown, clock: () => Date) {
  const parsed = QuoteSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(Date.parse(parsed.data.expires_at)) ||
      Date.parse(parsed.data.expires_at) <= clock().getTime())
    throw new ProviderError("Provider quote is invalid or expired");
  return parsed.data;
}
function validOutcome(input: unknown, requestId: string, quote?: Quote): Outcome {
  const parsed = OutcomeSchema.safeParse(input);
  if (!parsed.success || parsed.data.request_id !== requestId)
    throw new ProviderError("Provider outcome is invalid");
  const outcome = parsed.data;
  if (quote && (
    outcome.quote_id !== undefined && outcome.quote_id !== quote.id ||
    outcome.input_hash !== undefined && outcome.input_hash !== quote.input_hash
  )) throw new ProviderError("Provider outcome does not match the authorized request");
  if (outcome.state === "failed" && outcome.amount_minor !== 0)
    throw new ProviderError("A charged provider outcome requires reconciliation");
  if (quote && outcome.state === "confirmed" && outcome.amount_minor > quote.amount_minor)
    throw new ProviderError("Provider charge exceeds the authorized quote");
  return outcome;
}
function requestIdentifier(value: string) {
  if (!Identifier.safeParse(value).success) throw new ProviderError("Invalid provider request identifier");
  return value;
}

export interface HttpToolProviderOptions {
  id: string; origin: string; secret: string;
  fetcher?: typeof fetch; clock?: () => Date; timeoutMs?: number;
}

/** Fixed owner-configured bridge. Confirmation is provider-reported, not bank-settlement proof. */
export class HttpToolProvider implements ProviderAdapter {
  readonly id: string;
  readonly mode = "external" as const;
  #origin: URL;
  #secret: string;
  #fetcher: typeof fetch;
  #clock: () => Date;
  #timeoutMs: number;
  constructor(options: HttpToolProviderOptions) {
    this.id = requestIdentifier(options.id);
    let origin: URL;
    try { origin = new URL(options.origin); }
    catch { throw new ProviderError("Configure a public HTTPS provider origin"); }
    const hostname = origin.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!/^https:\/\//i.test(options.origin) || origin.protocol !== "https:" ||
        origin.username || origin.password || origin.search || origin.hash ||
        origin.pathname !== "/" || !hostname || isIP(hostname) ||
        hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))
      throw new ProviderError("Configure a public HTTPS provider origin without credentials or a path");
    if (typeof options.secret !== "string" || options.secret.length < 16 ||
        options.secret.length > 4096 || !/^[\x21-\x7e]+$/.test(options.secret))
      throw new ProviderError("Configure a valid server-side provider credential");
    const timeout = options.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30000)
      throw new ProviderError("Provider timeout must be between 100 and 30000 ms");
    this.#origin = origin;
    this.#secret = options.secret;
    this.#fetcher = options.fetcher ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#timeoutMs = timeout;
  }
  private async call(path: string, body?: unknown, idempotencyKey?: string): Promise<Response> {
    try {
      return await this.#fetcher(new URL(path, this.#origin), {
        method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { Accept: "application/json", Authorization: "Bearer " + this.#secret,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new ProviderError("Provider request unavailable; reconcile before retrying an execution"); }
  }
  private async read(response: Response): Promise<unknown> {
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError("Provider request was not confirmed (HTTP " + response.status + ")");
    }
    const contentType = response.headers.get("content-type") ?? "";
    const length = response.headers.get("content-length");
    if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/i.test(contentType) ||
        length !== null && (!/^\d+$/.test(length) || Number(length) > 262144)) {
      await response.body?.cancel();
      throw new ProviderError("Provider response must be bounded JSON");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError("Provider returned an empty response");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 262144) throw new ProviderError("Provider response exceeds 256 KiB");
        chunks.push(value);
      }
      const buffer = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
        const containsSecret = (value: unknown): boolean => {
          if (typeof value === "string") return value.includes(this.#secret);
          if (!value || typeof value !== "object") return false;
          return Object.entries(value).some(([key, item]) => key.includes(this.#secret) || containsSecret(item));
        };
        if (containsSecret(parsed)) throw new Error("Restricted provider response");
        return parsed;
      }
      catch { throw new ProviderError("Provider returned invalid JSON"); }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Provider response could not be read");
    } finally { await reader.cancel().catch(() => {}); }
  }
  async quote(input: unknown, inputHash: string): Promise<Quote> {
    if (!Hash.safeParse(inputHash).success || canonicalInputHash(input) !== inputHash)
      throw new ProviderError("Tool input does not match its fingerprint");
    const quote = validQuote(await this.read(await this.call("/quotes", { input, input_hash: inputHash })), this.#clock);
    if (quote.input_hash !== inputHash) throw new ProviderError("Provider quote does not match the tool input");
    return quote;
  }
  async execute(inputQuote: Quote, requestId: string, input: unknown): Promise<Outcome> {
    const quote = validQuote(inputQuote, this.#clock);
    requestIdentifier(requestId);
    if (canonicalInputHash(input) !== quote.input_hash) throw new ProviderError("Tool input changed after authorization");
    return validOutcome(await this.read(await this.call("/executions", {
      quote_id: quote.id, request_id: requestId, input,
    }, requestId)), requestId, quote);
  }
  async reconcile(requestId: string): Promise<Outcome> {
    requestIdentifier(requestId);
    const response = await this.call("/executions/" + encodeURIComponent(requestId));
    if (response.status === 404) {
      await response.body?.cancel();
      return { state: "pending", request_id: requestId, reason: "Provider has not confirmed this request; keep its reservation" };
    }
    return validOutcome(await this.read(response), requestId);
  }
}

/** In-memory fixture credits only. Restart loses receipts; unknown requests stay pending. */
export class SandboxToolProvider implements ProviderAdapter {
  readonly id: string;
  readonly mode = "sandbox" as const;
  #amount: number;
  #clock: () => Date;
  #lifetime: number;
  #quotes = new Map<string, Quote>();
  #outcomes = new Map<string, Outcome>();
  #claimedQuotes = new Map<string, string>();
  #executions = 0;
  constructor(options: { id?: string; amount_minor?: number; clock?: () => Date; quoteLifetimeMs?: number } = {}) {
    this.id = requestIdentifier(options.id ?? "sandbox-data");
    const amount = Minor.safeParse(options.amount_minor ?? 25);
    if (!amount.success) throw new ProviderError("Fixture price must use safe nonnegative integer credits");
    this.#amount = amount.data;
    this.#clock = options.clock ?? (() => new Date());
    this.#lifetime = options.quoteLifetimeMs ?? 300000;
    if (!Number.isSafeInteger(this.#lifetime) || this.#lifetime < 1000 || this.#lifetime > 3600000)
      throw new ProviderError("Fixture quote lifetime must be between one second and one hour");
  }
  get executionCount() { return this.#executions; }
  async quote(input: unknown, inputHash: string): Promise<Quote> {
    if (!Hash.safeParse(inputHash).success || canonicalInputHash(input) !== inputHash)
      throw new ProviderError("Tool input does not match its fingerprint");
    const quote: Quote = { id: randomUUID(), amount_minor: this.#amount, currency: "USD", input_hash: inputHash,
      expires_at: new Date(this.#clock().getTime() + this.#lifetime).toISOString() };
    this.#quotes.set(quote.id, quote);
    return structuredClone(quote);
  }
  async execute(inputQuote: Quote, requestId: string, input: unknown): Promise<Outcome> {
    requestIdentifier(requestId);
    const parsed = QuoteSchema.safeParse(inputQuote);
    const known = parsed.success ? this.#quotes.get(parsed.data.id) : undefined;
    if (!known || !parsed.success || JSON.stringify(known) !== JSON.stringify(parsed.data) || canonicalInputHash(input) !== known.input_hash)
      throw new ProviderError("Fixture request does not match its quote");
    const old = this.#outcomes.get(requestId);
    if (old) {
      if (old.quote_id !== known.id || old.input_hash !== known.input_hash)
        throw new ProviderError("Provider idempotency key already belongs to another request");
      return structuredClone(old);
    }
    validQuote(known, this.#clock);
    if (this.#claimedQuotes.has(known.id)) throw new ProviderError("Fixture quote was already consumed");
    const outcome: Outcome = { state: "confirmed", request_id: requestId, provider_request_id: "fixture-" + createHash("sha256").update(requestId).digest("hex"),
      quote_id: known.id, input_hash: known.input_hash, currency: "USD", amount_minor: this.#amount,
      result: { kind: "sandbox_fixture", input: JSON.parse(canonicalInput(input)) as unknown, note: "Fixture credits only. No bank or crypto payment." } };
    this.#claimedQuotes.set(known.id, requestId);
    this.#outcomes.set(requestId, outcome);
    this.#executions++;
    return structuredClone(outcome);
  }
  async reconcile(requestId: string): Promise<Outcome> {
    requestIdentifier(requestId);
    return structuredClone(this.#outcomes.get(requestId) ?? {
      state: "pending", request_id: requestId, reason: "No fixture receipt is available; keep its reservation",
    });
  }
}
