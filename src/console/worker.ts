import { createHash, randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { DurableSqlite, type DurableStorage } from "../workers/sqlite.js";
import { ConsoleService } from "./service.js";
import {
  consoleApp,
  sessionCookie,
  keyWorkspace,
  allowedOrigin,
  cookieName,
} from "./http.js";
interface Namespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface Env {
  WORKSPACES: Namespace;
  GATE: Namespace;
  PUBLIC_ORIGIN: string;
}
interface State {
  storage: DurableStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
const response = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export class ConsoleWorkspace {
  private db: DurableSqlite;
  private ready: Promise<void>;
  constructor(
    private state: State,
    private env: Env,
  ) {
    this.db = new DurableSqlite(state.storage);
    this.ready = state.blockConcurrencyWhile(async () => {
      const id = this.db
        .prepare("SELECT name FROM sqlite_master WHERE name=?")
        .get("console_meta");
      if (id) {
        const service = this.service();
        await this.schedule(service);
      }
    });
  }
  private service() {
    const id = this.db
      .prepare("SELECT value FROM console_meta WHERE key=?")
      .get("workspace_id") as { value: string } | undefined;
    return new ConsoleService(this.db, id?.value ?? "");
  }
  private async schedule(service: ConsoleService) {
    const next = service.nextAlarm();
    if (next === null) {
      if ((await this.state.storage.getAlarm()) !== null)
        await this.state.storage.deleteAlarm();
    } else await this.state.storage.setAlarm(next);
  }
  async fetch(request: Request) {
    await this.ready;
    const path = new URL(request.url).pathname;
    if (path === "/__initialize") {
      try {
        const input = z
          .strictObject({
            id: z.uuid(),
            name: z.string().trim().min(2).max(60),
          })
          .parse(await request.json());
        const service = new ConsoleService(this.db, input.id);
        const result = service.initialize(input.name);
        service.set("workspace_id", input.id);
        await this.state.storage.sync();
        return response(result, 201);
      } catch (e) {
        return response(
          {
            error:
              e instanceof ZodError
                ? "Use a workspace name between 2 and 60 characters"
                : "Workspace could not be created",
          },
          400,
        );
      }
    }
    if (
      !this.db
        .prepare("SELECT name FROM sqlite_master WHERE name=?")
        .get("console_meta")
    )
      return response({ error: "Workspace not found" }, 401);
    const service = this.service();
    const result = await consoleApp(service, this.env.PUBLIC_ORIGIN).fetch(
      request,
    );
    if (request.method === "POST") {
      await this.state.storage.sync();
      await this.schedule(service);
    }
    return result;
  }
  async alarm() {
    await this.ready;
    const service = this.service();
    try {
      service.tick();
      await this.state.storage.sync();
      await this.schedule(service);
    } catch {
      await this.state.storage.setAlarm(Date.now() + 30000);
    }
  }
}
/** Bounds anonymous demo creation without storing visitors' raw IP addresses. */
export class ConsoleGate {
  constructor(private state: State) {}
  async fetch(request: Request) {
    const key = await request.text();
    if (!/^[a-f0-9]{64}$/.test(key))
      return response({ error: "Invalid request" }, 400);
    const db = new DurableSqlite(this.state.storage);
    db.exec(
      "CREATE TABLE IF NOT EXISTS creation_limits(key TEXT PRIMARY KEY,n INTEGER NOT NULL,window INTEGER NOT NULL)",
    );
    const window = Math.floor(Date.now() / 3600000);
    const allowed = db
      .transaction(() => {
        db.prepare("DELETE FROM creation_limits WHERE window<?").run(window);
        const row = db
          .prepare("SELECT n FROM creation_limits WHERE key=?")
          .get(key) as { n: number } | undefined;
        if ((row?.n ?? 0) >= 100) return false;
        db.prepare(
          "INSERT INTO creation_limits(key,n,window) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET n=n+1",
        ).run(key, window);
        return true;
      })
      .immediate();
    return response({ allowed }, allowed ? 200 : 429);
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/console-api/health")
      return response({
        status: "ok",
        mode: "demo",
        storage: "durable-sqlite",
        background: "durable-alarms",
        external_payments: false,
      });
    if (!url.pathname.startsWith("/console-api/"))
      return response({ error: "Not found" }, 404);
    if (
      url.pathname === "/console-api/workspaces" &&
      request.method === "POST"
    ) {
      if (
        !allowedOrigin(
          request.headers.get("Origin") ?? undefined,
          env.PUBLIC_ORIGIN,
        )
      )
        return response({ error: "Create workspaces from the dashboard" }, 403);
      if (Number(request.headers.get("Content-Length") ?? 0) > 16384)
        return response({ error: "Request too large" }, 413);
      const ip = createHash("sha256")
        .update(request.headers.get("CF-Connecting-IP") ?? "shared")
        .digest("hex");
      const limit = await env.GATE.get(env.GATE.idFromName("creations")).fetch(
        new Request("https://gate.invalid", { method: "POST", body: ip }),
      );
      if (!limit.ok)
        return response(
          { error: "Demo creation limit reached. Try again later." },
          429,
        );
      let name: string;
      try {
        const text = await request.text();
        if (text.length > 16384)
          return response({ error: "Request too large" }, 413);
        name = z
          .strictObject({ name: z.string().trim().min(2).max(60) })
          .parse(JSON.parse(text)).name;
      } catch {
        return response(
          { error: "Use a workspace name between 2 and 60 characters" },
          400,
        );
      }
      const id = randomUUID(),
        result = await env.WORKSPACES.get(env.WORKSPACES.idFromName(id)).fetch(
          new Request("https://actor.invalid/__initialize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, name }),
          }),
        );
      if (!result.ok) return result;
      const session = (await result.json()) as {
        secret: string;
        expires_at: string;
      };
      return Response.json(
        { id, expires_at: session.expires_at, mode: "demo" },
        {
          status: 201,
          headers: {
            "Cache-Control": "no-store",
            "Set-Cookie": `${cookieName}=${id}.${session.secret}; Path=/console-api; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
          },
        },
      );
    }
    const id = url.pathname.startsWith("/console-api/v1/")
      ? keyWorkspace(request.headers.get("Authorization"))
      : sessionCookie(request.headers.get("Cookie"))?.id;
    if (!id || !z.uuid().safeParse(id).success)
      return response(
        {
          error: url.pathname.includes("/v1/")
            ? "Valid agent key required"
            : "Workspace session required",
        },
        401,
      );
    return env.WORKSPACES.get(env.WORKSPACES.idFromName(id)).fetch(request);
  },
};
