import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import { AppError } from "../errors.js";
import { ConsoleService, publicPayment } from "./service.js";

export const cookieName = "rg_console";
export function sessionCookie(header: string | null) {
  const value =
    header
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1) ?? "";
  const match = value.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
  return match ? { id: match[1]!, secret: match[2]! } : null;
}
export function keyWorkspace(header: string | null) {
  return (
    header?.match(
      /^Bearer rg_test\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/,
    )?.[1] ?? null
  );
}
export function allowedOrigin(
  origin: string | undefined,
  publicOrigin: string,
) {
  return origin === publicOrigin;
}
export function consoleApp(service: ConsoleService, publicOrigin: string) {
  const app = new Hono();
  app.use(
    "*",
    bodyLimit({
      maxSize: 16384,
      onError: (c) => c.json({ error: "Request exceeds 16 KiB" }, 413),
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.onError((e, c) =>
    e instanceof AppError
      ? c.json({ error: e.message }, e.status)
      : e instanceof ZodError || e instanceof SyntaxError
        ? c.json(
            {
              error: "Check the request fields",
              issues:
                e instanceof ZodError
                  ? e.issues.map((x) => ({ path: x.path, message: x.message }))
                  : [],
            },
            400,
          )
        : c.json(
            {
              error:
                "Request could not be completed. Retry with the same idempotency key.",
            },
            503,
          ),
  );
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/console-api/v1/")) {
      await next();
      return;
    }
    const session = sessionCookie(c.req.header("Cookie") ?? null);
    if (!session || session.id !== service.workspaceId)
      throw new AppError(401, "Workspace session required");
    service.checkOwner(session.secret);
    if (
      c.req.method !== "GET" &&
      !allowedOrigin(c.req.header("Origin"), publicOrigin)
    )
      throw new AppError(
        403,
        "Use the workspace dashboard to make owner changes",
      );
    await next();
  });
  app.get("/console-api/session", (c) => c.json(service.snapshot()));
  app.post("/console-api/recovery-code", async (c) => {
    z.strictObject({}).parse(await c.req.json());
    return c.json({ recovery_code: service.createRecoveryCode() });
  });
  app.post("/console-api/logout", async (c) => {
    z.strictObject({}).parse(await c.req.json());
    service.signOut();
    c.header(
      "Set-Cookie",
      `${cookieName}=; Path=/console-api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    );
    return c.json({ signed_out: true });
  });
  app.post("/console-api/agents/:id", async (c) =>
    c.json(service.updateAgent(c.req.param("id"), await c.req.json())),
  );
  app.post("/console-api/payments/:id/cancel", async (c) => {
    z.strictObject({}).parse(await c.req.json());
    return c.json(service.cancel(c.req.param("id")));
  });
  app.get("/console-api/payments/:id/receipt", (c) => {
    c.header(
      "Content-Disposition",
      'attachment; filename="internal-ledger-receipt.json"',
    );
    return c.json(service.receipt(c.req.param("id")));
  });
  app.post("/console-api/agents", async (c) =>
    c.json(service.createAgent(await c.req.json()), 201),
  );
  app.post("/console-api/keys", async (c) =>
    c.json(service.createKey(await c.req.json()), 201),
  );
  app.post("/console-api/keys/:id/revoke", async (c) => {
    z.strictObject({}).parse(await c.req.json());
    service.revokeKey(c.req.param("id"));
    return c.json({ status: "revoked" });
  });
  app.post("/console-api/rules", async (c) =>
    c.json(service.saveRules(await c.req.json())),
  );
  app.post("/console-api/payments/:id/decision", async (c) => {
    const i = z
      .strictObject({ action: z.enum(["approve", "reject"]) })
      .parse(await c.req.json());
    return c.json(service.decide(z.uuid().parse(c.req.param("id")), i.action));
  });
  app.get("/console-api/export", (c) => {
    c.header(
      "Content-Disposition",
      'attachment; filename="invisible-horses-audit.json"',
    );
    return c.json(service.exportRecords());
  });
  app.post("/console-api/v1/payments/:id/cancel", async (c) => {
    const key = service.authenticate(
      c.req.header("Authorization")?.slice(7) ?? "",
      "payments:write",
    );
    z.strictObject({}).parse(await c.req.json());
    return c.json(service.cancel(c.req.param("id"), key.agent_id));
  });
  app.get("/console-api/v1/payments/:id/receipt", (c) => {
    const key = service.authenticate(
      c.req.header("Authorization")?.slice(7) ?? "",
      "payments:read",
    );
    return c.json(service.receipt(c.req.param("id"), key.agent_id));
  });
  app.get("/console-api/v1/payments", (c) => {
    const key = service.authenticate(
      c.req.header("Authorization")?.slice(7) ?? "",
      "payments:read",
    );
    return c.json({
      data: service.payments(key.agent_id).map(publicPayment),
      test_money_only: true,
    });
  });
  app.get("/console-api/v1/payments/:id", (c) => {
    const key = service.authenticate(
      c.req.header("Authorization")?.slice(7) ?? "",
      "payments:read",
    );
    return c.json(service.payment(c.req.param("id"), key.agent_id));
  });
  app.post("/console-api/v1/payments", async (c) => {
    const key = service.authenticate(
      c.req.header("Authorization")?.slice(7) ?? "",
      "payments:write",
    );
    return c.json(await service.request(await c.req.json(), key.agent_id), 202);
  });
  app.notFound((c) => c.json({ error: "Endpoint not found" }, 404));
  return app;
}
