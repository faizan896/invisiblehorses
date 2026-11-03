import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import { AppError } from "../errors.js";
import { GateService } from "./service.js";

const amount = z.number().int().min(0).max(1_000_000_000);
const identifier = z.string().min(1).max(100);
const createAgent = z
  .object({
    customer_id: identifier,
    name: z.string().min(1).max(100),
    per_request_limit_minor: amount,
    daily_limit_minor: amount,
  })
  .strict();
const updateAgent = z
  .object({
    active: z.boolean().optional(),
    per_request_limit_minor: amount.optional(),
    daily_limit_minor: amount.optional(),
  })
  .strict()
  .refine((x) => Object.keys(x).length > 0);
const createJob = z
  .object({
    customer_id: identifier,
    name: z.string().min(1).max(100),
    budget_minor: amount,
    agent_ids: z.array(identifier).min(1).max(100),
    tool_ids: z.array(identifier).min(1).max(20),
  })
  .strict();
const updateJob = z
  .object({ budget_minor: amount.optional(), active: z.boolean().optional() })
  .strict()
  .refine((x) => Object.keys(x).length > 0);
const request = z
  .object({
    job_id: identifier,
    tool_id: identifier,
    input: z.unknown(),
    idempotency_key: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  })
  .strict()
  .refine((x) => Object.hasOwn(x, "input"));
const empty = z.object({}).strict();
const digest = (value: string) => createHash("sha256").update(value).digest();

export function toolGateApp(service: GateService, ownerToken: string) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(ownerToken))
    throw new Error(
      "TOOL_GATE_OWNER_TOKEN must be a random 32-256 character token",
    );
  const ownerDigest = digest(ownerToken);
  const app = new Hono();
  app.use(
    "*",
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.json({ error: "Request exceeds 64 KiB" }, 413),
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof AppError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({ error: "Check the request fields" }, 400);
    return c.json(
      {
        error:
          "Service unavailable; preserve the original request and idempotency key",
      },
      503,
    );
  });
  const bearer = (header: string | undefined) =>
    header?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1] ?? "";
  app.use("/owner/*", async (c, next) => {
    if (
      !timingSafeEqual(
        digest(bearer(c.req.header("Authorization"))),
        ownerDigest,
      )
    )
      throw new AppError(401, "Owner authentication required");
    await next();
  });
  const agent = (header: string | undefined) =>
    service.authenticate(bearer(header));
  app.get("/health", (c) => c.json({ ok: true, service: "tool-gate" }));
  app.get("/owner/summary", (c) => c.json(service.snapshot()));
  app.post("/owner/agents", async (c) =>
    c.json(service.createAgent(createAgent.parse(await c.req.json())), 201),
  );
  app.patch("/owner/agents/:id", async (c) =>
    c.json(
      service.updateAgent(
        c.req.param("id"),
        updateAgent.parse(await c.req.json()),
      ),
    ),
  );
  app.post("/owner/keys/:id/revoke", async (c) => {
    empty.parse(await c.req.json());
    service.revokeKey(c.req.param("id"));
    return c.json({ revoked: true });
  });
  app.post("/owner/jobs", async (c) =>
    c.json(service.createJob(createJob.parse(await c.req.json())), 201),
  );
  app.patch("/owner/jobs/:id", async (c) =>
    c.json(
      service.updateJob(c.req.param("id"), updateJob.parse(await c.req.json())),
    ),
  );
  app.get("/owner/requests", (c) => c.json(service.listRequests()));
  app.get("/owner/requests/:id", (c) =>
    c.json(service.getRequest(c.req.param("id"))),
  );
  app.get("/owner/requests/:id/receipt", (c) =>
    c.json(service.receipt(c.req.param("id"))),
  );
  app.post("/owner/requests/:id/approve", async (c) => {
    empty.parse(await c.req.json());
    return c.json(service.decide(c.req.param("id"), true));
  });
  app.post("/owner/requests/:id/reject", async (c) => {
    empty.parse(await c.req.json());
    return c.json(service.decide(c.req.param("id"), false));
  });
  app.post("/owner/requests/:id/cancel", async (c) => {
    empty.parse(await c.req.json());
    return c.json(service.cancel(c.req.param("id")));
  });
  app.post("/v1/requests", async (c) => {
    const identity = agent(c.req.header("Authorization"));
    return c.json(
      await service.request(identity, request.parse(await c.req.json())),
      202,
    );
  });
  app.get("/v1/requests", (c) =>
    c.json(service.listRequests(agent(c.req.header("Authorization")))),
  );
  app.get("/v1/requests/:id", (c) =>
    c.json(
      service.getRequest(
        c.req.param("id"),
        agent(c.req.header("Authorization")),
      ),
    ),
  );
  app.get("/v1/requests/:id/receipt", (c) =>
    c.json(
      service.receipt(c.req.param("id"), agent(c.req.header("Authorization"))),
    ),
  );
  app.post("/v1/requests/:id/cancel", async (c) => {
    const identity = agent(c.req.header("Authorization"));
    empty.parse(await c.req.json());
    return c.json(service.cancel(c.req.param("id"), identity));
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}
