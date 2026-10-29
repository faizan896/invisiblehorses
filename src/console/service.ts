import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  Counterparties,
  LedgerAdapter,
  QuoteService,
  planRoutes,
  policyIntent,
  evaluate,
  PolicySchema,
  PaymentIntentV2Schema,
  minor,
  decimal,
  MoneySchema,
  type RouteQuote,
  type Policy,
} from "payroute";
import type { SqlDatabase } from "../audit/store-core.js";
import { AppError } from "../errors.js";
import catalog from "../../examples/counterparties.json" with { type: "json" };

const profiles = new Counterparties(catalog);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const Name = z.string().trim().min(2).max(60);
const Amount = MoneySchema.refine(
  (v) => minor(v) > 0 && minor(v) <= 100000000,
  "Use a positive amount up to $1,000,000",
);
export const RulesSchema = z.strictObject({
  per_payment: Amount,
  daily: Amount,
  approval_above: MoneySchema,
  merchants: z
    .array(z.enum(["dataco", "compute-co"]))
    .min(1)
    .max(2)
    .refine((v) => new Set(v).size === v.length, "Choose each vendor once"),
});
export const AgentSchema = z.strictObject({
  name: Name,
  per_payment: Amount,
  daily: Amount,
});
export const RequestSchema = z.strictObject({
  idempotency_key: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  recipient: z.enum(["dataco", "compute-co"]),
  amount: Amount,
  purpose: z.string().trim().min(1).max(300),
});
export type Rules = z.infer<typeof RulesSchema>;
type AgentRow = {
  id: string;
  name: string;
  per_payment: string;
  daily: string;
  active: number;
  created_at: string;
};
type KeyRow = {
  id: string;
  agent_id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  scopes: string;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
};
export type ConsolePayment = {
  id: string;
  agent_id: string;
  idempotency_key: string;
  fingerprint: string;
  recipient: string;
  amount: string;
  purpose: string;
  status:
    | "queued"
    | "pending_approval"
    | "completed"
    | "denied"
    | "rejected"
    | "expired"
    | "cancelled";
  reasons: string;
  quote: string | null;
  created_at: string;
  updated_at: string;
  ready_at: string;
  approval_expires_at: string | null;
  approved: number;
};
export const publicPayment = (p: ConsolePayment) => ({
  id: p.id,
  agent_id: p.agent_id,
  idempotency_key: p.idempotency_key,
  recipient: p.recipient,
  amount: p.amount,
  currency: "USD" as const,
  purpose: p.purpose,
  status: p.status,
  reasons: JSON.parse(p.reasons) as string[],
  route: p.quote ? "Internal test ledger" : null,
  created_at: p.created_at,
  updated_at: p.updated_at,
  approval_expires_at: p.approval_expires_at,
  test_money_only: true,
});

const week = 7 * 86400000;

/** Private demo workspace, with the same deterministic policy engine as payroute. No external execution. */
export class ConsoleService {
  constructor(
    readonly db: SqlDatabase,
    readonly workspaceId: string,
    readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS console_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS console_agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,per_payment TEXT NOT NULL,daily TEXT NOT NULL,active INTEGER NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS console_keys(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES console_agents(id),name TEXT NOT NULL,prefix TEXT NOT NULL,secret_hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL,last_used_at TEXT);
  CREATE TABLE IF NOT EXISTS console_payments(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES console_agents(id),idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,recipient TEXT NOT NULL,amount TEXT NOT NULL,purpose TEXT NOT NULL,status TEXT NOT NULL,reasons TEXT NOT NULL,quote TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,ready_at TEXT NOT NULL,approval_expires_at TEXT,approved INTEGER NOT NULL DEFAULT 0,UNIQUE(agent_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS console_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,actor TEXT NOT NULL,payment_id TEXT,details TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS console_audit_no_update BEFORE UPDATE ON console_audit BEGIN SELECT RAISE(ABORT,'Audit is append-only');END;
  CREATE TRIGGER IF NOT EXISTS console_audit_no_delete BEFORE DELETE ON console_audit BEGIN SELECT RAISE(ABORT,'Audit is append-only');END;
  CREATE TABLE IF NOT EXISTS console_journal(payment_id TEXT NOT NULL,account TEXT NOT NULL,amount_minor INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(payment_id,account));
  CREATE INDEX IF NOT EXISTS console_queue ON console_payments(status,ready_at);
  CREATE INDEX IF NOT EXISTS console_history ON console_payments(created_at,status);`);
  }
  now() {
    return this.clock().toISOString();
  }
  meta(key: string) {
    return (
      this.db.prepare("SELECT value FROM console_meta WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  set(key: string, value: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO console_meta(key,value) VALUES(?,?)")
      .run(key, value);
  }
  transaction<T>(fn: () => T) {
    return this.db.transaction(fn).immediate();
  }
  audit(
    event: string,
    actor: string,
    paymentId: string | null,
    details: unknown,
  ) {
    this.db
      .prepare(
        "INSERT INTO console_audit(event,actor,payment_id,details,created_at) VALUES(?,?,?,?,?)",
      )
      .run(event, actor, paymentId, JSON.stringify(details), this.now());
  }
  initialize(name: unknown) {
    const valid = Name.parse(name);
    if (this.meta("owner_hash"))
      throw new AppError(409, "Workspace already exists");
    const secret = randomBytes(32).toString("base64url");
    this.transaction(() => {
      this.set("name", valid);
      this.set("owner_hash", hash(secret));
      this.set("created_at", this.now());
      this.set(
        "expires_at",
        new Date(this.clock().getTime() + week).toISOString(),
      );
      this.set(
        "rules",
        JSON.stringify({
          per_payment: "1000.00",
          daily: "2500.00",
          approval_above: "50.00",
          merchants: ["dataco", "compute-co"],
        }),
      );
      this.audit("workspace.created", "owner", null, {
        name: valid,
        mode: "demo",
        starting_credits: "10000.00",
      });
      this.createAgent({
        name: "Procurement agent",
        per_payment: "100.00",
        daily: "500.00",
      });
    });
    return {
      id: this.workspaceId,
      secret,
      expires_at: this.meta("expires_at")!,
      recovery_code: this.createRecoveryCode(),
    };
  }
  checkOwner(secret: string) {
    if (
      !secret ||
      !this.meta("owner_hash") ||
      !equal(hash(secret), this.meta("owner_hash")!)
    )
      throw new AppError(401, "Workspace session required");
    this.checkExpiry();
  }
  checkExpiry() {
    if (
      !this.meta("expires_at") ||
      Date.parse(this.meta("expires_at")!) <= this.clock().getTime()
    )
      throw new AppError(
        401,
        "Workspace access expired. Use your recovery key to restore access.",
      );
  }
  createRecoveryCode() {
    const token = `ih_recovery.${this.workspaceId}.${randomBytes(32).toString("base64url")}`;
    this.transaction(() => {
      this.set("recovery_hash", hash(token));
      this.audit("workspace.recovery_created", "owner", null, {});
    });
    return token;
  }
  recover(token: string) {
    const expected = this.meta("recovery_hash");
    if (!expected || !equal(hash(token), expected))
      throw new AppError(401, "Invalid recovery key");
    return this.transaction(() => {
      const secret = randomBytes(32).toString("base64url");
      this.set("owner_hash", hash(secret));
      this.set(
        "expires_at",
        new Date(this.clock().getTime() + week).toISOString(),
      );
      this.db
        .prepare(
          "UPDATE console_keys SET revoked_at=? WHERE revoked_at IS NULL",
        )
        .run(this.now());
      for (const payment of this.payments()) {
        if (["queued", "pending_approval"].includes(payment.status))
          this.status(
            payment.id,
            "cancelled",
            ["Cancelled during workspace recovery"],
            "owner",
          );
      }
      const recovery_code = token;
      this.audit("workspace.recovered", "owner", null, {
        keys_revoked: true,
        pending_requests_cancelled: true,
      });
      return { secret, recovery_code, expires_at: this.meta("expires_at")! };
    });
  }
  signOut() {
    if (!this.meta("recovery_hash"))
      throw new AppError(409, "Save a recovery key before signing out");
    this.transaction(() => {
      this.set("owner_hash", hash(randomBytes(32).toString("base64url")));
      this.audit("workspace.signed_out", "owner", null, {});
    });
  }
  rules(): Rules {
    return RulesSchema.parse(JSON.parse(this.meta("rules")!));
  }
  saveRules(input: unknown) {
    const rules = RulesSchema.parse(input);
    this.transaction(() => {
      this.set("rules", JSON.stringify(rules));
      this.audit("policy.updated", "owner", null, rules);
    });
    return rules;
  }
  agents() {
    return this.db
      .prepare("SELECT * FROM console_agents ORDER BY created_at,id")
      .all() as AgentRow[];
  }
  createAgent(input: unknown) {
    const i = AgentSchema.parse(input);
    if (this.agents().length >= 20)
      throw new AppError(409, "This demo supports up to 20 agents");
    const a = { id: randomUUID(), ...i, active: 1, created_at: this.now() };
    this.db
      .prepare(
        "INSERT INTO console_agents(id,name,per_payment,daily,active,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(a.id, a.name, a.per_payment, a.daily, a.active, a.created_at);
    this.audit("agent.created", "owner", null, {
      id: a.id,
      name: a.name,
      per_payment: a.per_payment,
      daily: a.daily,
    });
    return a;
  }
  updateAgent(id: string, input: unknown) {
    z.uuid().parse(id);
    const next = AgentSchema.extend({ active: z.boolean() }).parse(input);
    return this.transaction(() => {
      if (!this.agents().some((agent) => agent.id === id))
        throw new AppError(404, "Agent not found");
      this.db
        .prepare(
          "UPDATE console_agents SET name=?,per_payment=?,daily=?,active=? WHERE id=?",
        )
        .run(next.name, next.per_payment, next.daily, Number(next.active), id);
      this.audit("agent.updated", "owner", null, { id, ...next });
      return this.agents().find((agent) => agent.id === id)!;
    });
  }
  keys() {
    return this.db
      .prepare(
        "SELECT id,agent_id,name,prefix,scopes,revoked_at,created_at,last_used_at FROM console_keys ORDER BY created_at DESC",
      )
      .all()
      .map((x) => {
        const k = x as Omit<KeyRow, "secret_hash">;
        return { ...k, scopes: JSON.parse(k.scopes) as string[] };
      });
  }
  createKey(input: unknown) {
    const i = z
      .strictObject({
        agent_id: z.uuid(),
        name: Name,
        scopes: z
          .array(z.enum(["payments:read", "payments:write"]))
          .min(1)
          .max(2),
      })
      .parse(input);
    if (!this.agents().some((a) => a.id === i.agent_id && a.active))
      throw new AppError(404, "Active agent not found");
    if (this.keys().filter((k) => !k.revoked_at).length >= 20)
      throw new AppError(
        409,
        "Revoke an unused key first; this demo allows 20 active keys",
      );
    const secret = randomBytes(32).toString("base64url"),
      token = `rg_test.${this.workspaceId}.${secret}`,
      id = randomUUID(),
      prefix = `rg_test…${secret.slice(-6)}`;
    this.db
      .prepare(
        "INSERT INTO console_keys(id,agent_id,name,prefix,secret_hash,scopes,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        i.agent_id,
        i.name,
        prefix,
        hash(token),
        JSON.stringify([...new Set(i.scopes)]),
        this.now(),
      );
    this.audit("key.created", "owner", null, {
      id,
      agent_id: i.agent_id,
      scopes: i.scopes,
    });
    return { id, key: token, prefix, scopes: i.scopes };
  }
  revokeKey(id: string) {
    z.uuid().parse(id);
    const result = this.db
      .prepare(
        "UPDATE console_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
      )
      .run(this.now(), id);
    if (!result.changes) throw new AppError(404, "Active key not found");
    this.audit("key.revoked", "owner", null, { id });
  }
  authenticate(token: string, scope: string) {
    this.checkExpiry();
    const k = this.db
      .prepare(
        "SELECT * FROM console_keys WHERE secret_hash=? AND revoked_at IS NULL",
      )
      .get(hash(token)) as KeyRow | undefined;
    if (!k || !this.agents().some((a) => a.id === k.agent_id && a.active))
      throw new AppError(401, "Invalid or revoked agent key");
    if (!(JSON.parse(k.scopes) as string[]).includes(scope))
      throw new AppError(403, `Key requires ${scope}`);
    this.db
      .prepare("UPDATE console_keys SET last_used_at=? WHERE id=?")
      .run(this.now(), k.id);
    return k;
  }
  policy(agent?: AgentRow): Policy {
    const r = this.rules();
    const per = agent
      ? decimal(Math.min(minor(r.per_payment), minor(agent.per_payment)))
      : r.per_payment;
    return PolicySchema.parse({
      max_per_payment: per,
      max_per_day: agent ? agent.daily : r.daily,
      new_merchant_max: per,
      require_approval_above: r.approval_above,
      expires_at: this.meta("expires_at"),
      allowed_merchants: r.merchants.map((id) => ({ id })),
      routing: { allowed_rails: ["ledger"] },
    });
  }
  history(exclude = "", agentId?: string) {
    const start = this.now().slice(0, 10) + "T00:00:00.000Z";
    const total = this.db
      .prepare(
        `SELECT COALESCE(SUM(CAST(REPLACE(amount,'.','') AS INTEGER)),0) n FROM console_payments WHERE id!=? AND (status IN ('queued','pending_approval') OR (status='completed' AND updated_at>=?))${agentId ? " AND agent_id=?" : ""}`,
      )
      .get(...[exclude, start, ...(agentId ? [agentId] : [])]) as { n: number };
    return {
      now: this.now(),
      spent_today: decimal(total.n),
      paid_merchants: [],
    };
  }
  balance() {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount_minor),0) n FROM console_journal WHERE account='treasury'",
      )
      .get() as { n: number };
    return 1000000 + row.n;
  }
  reserved(exclude = "") {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(CAST(REPLACE(amount,'.','') AS INTEGER)),0) n FROM console_payments WHERE id!=? AND status IN ('queued','pending_approval')",
      )
      .get(exclude) as { n: number };
    return row.n;
  }
  private get(id: string) {
    return this.db
      .prepare("SELECT * FROM console_payments WHERE id=?")
      .get(id) as ConsolePayment | undefined;
  }
  private routedIntent(
    p: Pick<
      ConsolePayment,
      "idempotency_key" | "recipient" | "amount" | "purpose"
    >,
  ) {
    return PaymentIntentV2Schema.parse({
      idempotency_key: p.idempotency_key,
      payer: "research-agent-07",
      recipient: p.recipient,
      amount: p.amount,
      destination_currency: "USD",
      deadline: new Date(this.clock().getTime() + 3600000).toISOString(),
      purpose: p.purpose,
      max_fee: "0.00",
      reversibility_requirement: "none",
      recipient_preferences: { delivery: "internal" },
    });
  }
  private evaluation(
    p: Pick<
      ConsolePayment,
      "idempotency_key" | "recipient" | "amount" | "purpose" | "agent_id"
    >,
    quotes: RouteQuote[],
    exclude = "",
  ) {
    const agent = this.agents().find((a) => a.id === p.agent_id);
    if (!agent) throw new AppError(404, "Agent not found");
    if (!agent.active)
      return {
        decision: "deny" as const,
        reasons: ["Agent is paused"],
        quote: null,
      };
    const intent = this.routedIntent(p),
      recipient = profiles.get(p.recipient);
    const plan = planRoutes(
      {
        intent,
        payer: profiles.get("research-agent-07"),
        recipient,
        policy: this.policy(),
        history: this.history(exclude),
        quotes,
        unavailable: [],
      },
      "cheapest-by-deadline",
    );
    if (!plan.selected)
      return {
        decision: "deny" as const,
        reasons: plan.alternatives.flatMap((a) => a.reasons),
        quote: null,
      };
    const mapped = policyIntent(intent, recipient, plan.selected),
      e = evaluate(
        mapped,
        this.policy(agent),
        this.history(exclude, agent.id),
        { routed: true },
      );
    if (e.decision === "deny") return { ...e, quote: plan.selected };
    if (minor(p.amount) > this.balance() - this.reserved(exclude))
      return {
        decision: "deny" as const,
        reasons: ["Insufficient available demo credits"],
        quote: plan.selected,
      };
    return {
      decision:
        plan.decision === "needs_approval" || e.decision === "needs_approval"
          ? ("needs_approval" as const)
          : ("allow" as const),
      reasons: plan.decision === "needs_approval" ? plan.reasons : e.reasons,
      quote: plan.selected,
    };
  }
  async request(input: unknown, agentId: string) {
    const i = RequestSchema.parse(input),
      canonical = { ...i, amount: decimal(minor(i.amount)) },
      fingerprint = hash(JSON.stringify(canonical));
    const existing = this.db
      .prepare(
        "SELECT * FROM console_payments WHERE agent_id=? AND idempotency_key=?",
      )
      .get(agentId, i.idempotency_key) as ConsolePayment | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new AppError(
          409,
          "Idempotency key already used for different payment details",
        );
      return publicPayment(existing);
    }
    const intent = this.routedIntent(canonical);
    const result = await new QuoteService(
      profiles,
      [new LedgerAdapter()],
      this.clock,
    ).quotes(intent, intent.payer);
    return this.transaction(() => {
      const duplicate = this.db
        .prepare(
          "SELECT * FROM console_payments WHERE agent_id=? AND idempotency_key=?",
        )
        .get(agentId, i.idempotency_key) as ConsolePayment | undefined;
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint)
          throw new AppError(
            409,
            "Idempotency key already used for different payment details",
          );
        return publicPayment(duplicate);
      }
      if (this.payments().length >= 200)
        throw new AppError(409, "This demo workspace supports 200 payments");
      const e = this.evaluation(
        { ...canonical, agent_id: agentId },
        result.quotes,
      );
      const now = this.now(),
        p: ConsolePayment = {
          id: randomUUID(),
          agent_id: agentId,
          ...canonical,
          fingerprint,
          status:
            e.decision === "deny"
              ? "denied"
              : e.decision === "needs_approval"
                ? "pending_approval"
                : "queued",
          reasons: JSON.stringify(e.reasons),
          quote: e.quote ? JSON.stringify(e.quote) : null,
          created_at: now,
          updated_at: now,
          ready_at: new Date(this.clock().getTime() + 5000).toISOString(),
          approval_expires_at:
            e.decision === "needs_approval"
              ? new Date(this.clock().getTime() + 900000).toISOString()
              : null,
          approved: 0,
        };
      this.db
        .prepare(
          "INSERT INTO console_payments(id,agent_id,idempotency_key,fingerprint,recipient,amount,purpose,status,reasons,quote,created_at,updated_at,ready_at,approval_expires_at,approved) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          p.id,
          p.agent_id,
          p.idempotency_key,
          p.fingerprint,
          p.recipient,
          p.amount,
          p.purpose,
          p.status,
          p.reasons,
          p.quote,
          p.created_at,
          p.updated_at,
          p.ready_at,
          p.approval_expires_at,
          p.approved,
        );
      this.audit("payment.requested", agentId, p.id, {
        amount: p.amount,
        recipient: p.recipient,
        status: p.status,
      });
      this.audit(`payment.${p.status}`, "policy", p.id, { reasons: e.reasons });
      return publicPayment(p);
    });
  }
  payments(agentId?: string) {
    return this.db
      .prepare(
        `SELECT * FROM console_payments${agentId ? " WHERE agent_id=?" : ""} ORDER BY created_at DESC,id`,
      )
      .all(...(agentId ? [agentId] : [])) as ConsolePayment[];
  }
  payment(id: string, agentId?: string) {
    z.uuid().parse(id);
    const p = this.get(id);
    if (!p || (agentId && p.agent_id !== agentId))
      throw new AppError(404, "Payment not found");
    return publicPayment(p);
  }
  cancel(id: string, agentId?: string) {
    z.uuid().parse(id);
    return this.transaction(() => {
      const payment = this.get(id);
      if (!payment || (agentId && payment.agent_id !== agentId))
        throw new AppError(404, "Payment not found");
      if (payment.status === "cancelled") return publicPayment(payment);
      if (!["queued", "pending_approval"].includes(payment.status))
        throw new AppError(
          409,
          "Only queued or pending requests can be cancelled",
        );
      this.status(
        id,
        "cancelled",
        ["Cancelled before settlement"],
        agentId ?? "owner",
      );
      return publicPayment(this.get(id)!);
    });
  }
  receipt(id: string, agentId?: string) {
    const payment = this.payment(id, agentId);
    if (payment.status !== "completed")
      throw new AppError(409, "Receipt is available after internal settlement");
    const entries = this.db
      .prepare(
        "SELECT account,amount_minor,created_at FROM console_journal WHERE payment_id=? ORDER BY account",
      )
      .all(id) as {
      account: string;
      amount_minor: number;
      created_at: string;
    }[];
    const balanced =
      entries.length === 2 &&
      entries.reduce((total, row) => total + row.amount_minor, 0) === 0 &&
      entries.some(
        (row) =>
          row.account === "treasury" &&
          row.amount_minor === -minor(payment.amount),
      ) &&
      entries.some(
        (row) =>
          row.account === `merchant:${payment.recipient}` &&
          row.amount_minor === minor(payment.amount),
      );
    if (!balanced)
      throw new AppError(503, "Ledger entries could not be reconciled");
    return {
      payment,
      entries,
      balanced,
      settlement: "internal_test_ledger",
      external_payment: false,
      test_money_only: true,
    };
  }
  private status(
    id: string,
    status: ConsolePayment["status"],
    reasons: string[],
    actor: string,
  ) {
    this.db
      .prepare(
        "UPDATE console_payments SET status=?,reasons=?,updated_at=? WHERE id=?",
      )
      .run(status, JSON.stringify(reasons), this.now(), id);
    this.audit(`payment.${status}`, actor, id, { reasons });
  }
  decide(id: string, action: "approve" | "reject") {
    return this.transaction(() => {
      const p = this.get(id);
      if (!p) throw new AppError(404, "Payment not found");
      if (p.status !== "pending_approval")
        throw new AppError(409, "This payment no longer needs approval");
      if (Date.parse(p.approval_expires_at!) <= this.clock().getTime()) {
        this.status(id, "expired", ["Approval expired"], "worker");
        return publicPayment(this.get(id)!);
      }
      if (action === "reject") {
        this.status(id, "rejected", ["Rejected by workspace owner"], "owner");
        return publicPayment(this.get(id)!);
      }
      const old = p.quote ? (JSON.parse(p.quote) as RouteQuote) : null;
      const quote = old
        ? {
            ...old,
            quoted_at: this.now(),
            expires_at: new Date(this.clock().getTime() + 300000).toISOString(),
            expected_available_at: this.now(),
            latest_available_at: this.now(),
          }
        : null;
      const e = this.evaluation(p, quote ? [quote] : [], id);
      if (e.decision === "deny") {
        this.status(id, "denied", e.reasons, "policy");
        return publicPayment(this.get(id)!);
      }
      this.db
        .prepare("UPDATE console_payments SET approved=1,ready_at=? WHERE id=?")
        .run(new Date(this.clock().getTime() + 5000).toISOString(), id);
      this.status(id, "queued", ["Approved by workspace owner"], "owner");
      return publicPayment(this.get(id)!);
    });
  }
  /** Invoked by Durable Object alarms, never by reads or client polling. Settlement and journal share one transaction. */
  tick() {
    this.transaction(() => {
      this.set("worker_last_run", this.now());
      for (const p of this.payments().reverse()) {
        if (
          p.status === "pending_approval" &&
          Date.parse(p.approval_expires_at!) <= this.clock().getTime()
        ) {
          this.status(
            p.id,
            "expired",
            ["Approval expired after 15 minutes"],
            "worker",
          );
          continue;
        }
        if (
          p.status !== "queued" ||
          Date.parse(p.ready_at) > this.clock().getTime()
        )
          continue;
        // Quotes expire after five minutes. Internal ledger semantics can be re-attested at dispatch without external pricing.
        const old = JSON.parse(p.quote!) as RouteQuote;
        const quote = {
          ...old,
          quoted_at: this.now(),
          expires_at: new Date(this.clock().getTime() + 300000).toISOString(),
          expected_available_at: this.now(),
          latest_available_at: this.now(),
        };
        const e = this.evaluation(p, [quote], p.id);
        if (e.decision === "deny") {
          this.status(p.id, "denied", e.reasons, "policy");
          continue;
        }
        if (e.decision === "needs_approval" && !p.approved) {
          this.db
            .prepare(
              "UPDATE console_payments SET approval_expires_at=? WHERE id=?",
            )
            .run(new Date(this.clock().getTime() + 900000).toISOString(), p.id);
          this.status(
            p.id,
            "pending_approval",
            ["Current rules require owner approval"],
            "policy",
          );
          continue;
        }
        this.db
          .prepare(
            "INSERT INTO console_journal(payment_id,account,amount_minor,created_at) VALUES(?,?,?,?)",
          )
          .run(p.id, "treasury", -minor(p.amount), this.now());
        this.db
          .prepare(
            "INSERT INTO console_journal(payment_id,account,amount_minor,created_at) VALUES(?,?,?,?)",
          )
          .run(p.id, `merchant:${p.recipient}`, minor(p.amount), this.now());
        this.status(
          p.id,
          "completed",
          ["Settled in the internal demo ledger. No external money moved."],
          "worker",
        );
      }
    });
  }
  nextAlarm() {
    if (Date.parse(this.meta("expires_at") ?? "0") <= this.clock().getTime())
      return null;
    const times = this.payments().flatMap((p) =>
      p.status === "queued"
        ? [Date.parse(p.ready_at)]
        : p.status === "pending_approval"
          ? [Date.parse(p.approval_expires_at!)]
          : [],
    );
    return times.length
      ? Math.max(this.clock().getTime() + 500, Math.min(...times))
      : null;
  }
  exportRecords() {
    const { workspace, rules, agents, payments, balance } = this.snapshot();
    const audit = this.db
      .prepare("SELECT * FROM console_audit ORDER BY id")
      .all()
      .map((value) => {
        const row = value as {
          id: number;
          event: string;
          actor: string;
          payment_id: string | null;
          details: string;
          created_at: string;
        };
        return { ...row, details: JSON.parse(row.details) as unknown };
      });
    const journal = this.db
      .prepare(
        "SELECT payment_id,account,amount_minor,created_at FROM console_journal ORDER BY created_at,payment_id,account",
      )
      .all();
    return {
      exported_at: this.now(),
      workspace,
      rules,
      agents,
      payments,
      balance,
      audit,
      journal,
      test_money_only: true,
    };
  }
  snapshot() {
    const payments = this.payments().map(publicPayment),
      agents = this.agents();
    return {
      workspace: {
        id: this.workspaceId,
        name: this.meta("name"),
        mode: "demo",
        created_at: this.meta("created_at"),
        expires_at: this.meta("expires_at"),
        recovery_enabled: Boolean(this.meta("recovery_hash")),
      },
      rules: this.rules(),
      agents,
      keys: this.keys(),
      payments,
      audit: this.db
        .prepare("SELECT * FROM console_audit ORDER BY id DESC LIMIT 100")
        .all()
        .map((x) => {
          const row = x as {
            id: number;
            event: string;
            actor: string;
            payment_id: string | null;
            details: string;
            created_at: string;
          };
          return { ...row, details: JSON.parse(row.details) as unknown };
        }),
      balance: {
        total: decimal(this.balance()),
        reserved: decimal(this.reserved()),
        available: decimal(this.balance() - this.reserved()),
        spent_today: this.history().spent_today,
        currency: "USD",
        kind: "internal_demo_credits",
      },
      worker: {
        kind: "Cloudflare Durable Object alarms",
        last_run_at: this.meta("worker_last_run") ?? null,
        next_run_at:
          this.nextAlarm() === null
            ? null
            : new Date(this.nextAlarm()!).toISOString(),
        runs_without_browser: true,
      },
      providers: [
        { id: "ledger", name: "Internal demo ledger", status: "available" },
        { id: "bank", name: "Bank payouts", status: "not_connected" },
        { id: "usdc", name: "USDC wallet transfers", status: "not_connected" },
      ],
    };
  }
}
