import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { GateService } from "./service.js";
import {
  HttpToolProvider,
  SandboxToolProvider,
  type ProviderAdapter,
} from "./provider.js";
import { toolGateApp } from "./http.js";

const minor = z.number().int().min(0).max(1_000_000_000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const configSchema = z
  .object({
    company: z
      .object({
        daily_limit_minor: minor,
        per_request_limit_minor: minor,
        approval_above_minor: minor,
      })
      .strict(),
    providers: z
      .array(
        z.discriminatedUnion("mode", [
          z
            .object({ id, mode: z.literal("sandbox"), price_minor: minor })
            .strict(),
          z
            .object({
              id,
              mode: z.literal("external"),
              origin: z.string().url(),
              token_env: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine(
    (x) => new Set(x.providers.map((p) => p.id)).size === x.providers.length,
    "Provider IDs must be unique",
  );

export function startToolGate(env: NodeJS.ProcessEnv = process.env) {
  process.umask(0o077);
  const ownerToken = env.TOOL_GATE_OWNER_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(ownerToken))
    throw new Error(
      "Set a random TOOL_GATE_OWNER_TOKEN of at least 32 characters",
    );
  if (!env.TOOL_GATE_CONFIG)
    throw new Error(
      "TOOL_GATE_CONFIG must name an owner-controlled JSON configuration file",
    );
  const config = configSchema.parse(
    JSON.parse(readFileSync(env.TOOL_GATE_CONFIG, "utf8")),
  );
  const providers: ProviderAdapter[] = config.providers.map((provider) => {
    if (provider.mode === "sandbox")
      return new SandboxToolProvider({
        id: provider.id,
        amount_minor: provider.price_minor,
      });
    const secret = env[provider.token_env];
    if (!secret) throw new Error("A configured provider credential is missing");
      if (secret === ownerToken) throw new Error("Provider credentials must be distinct from the owner token");
    return new HttpToolProvider({
      id: provider.id,
      origin: provider.origin,
      secret,
    });
  });
  const dbPath = env.TOOL_GATE_DB ?? "data/tool-gate.sqlite";
  if (dbPath !== ":memory:")
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  if (dbPath !== ":memory:") chmodSync(dbPath, 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  try {
    const service = new GateService(db, providers, config.company);
    const app = toolGateApp(service, ownerToken);
    const port = Number(env.TOOL_GATE_PORT ?? "8410");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("TOOL_GATE_PORT must be a valid port");
    const host = env.TOOL_GATE_HOST ?? "127.0.0.1";
    const server = serve({ fetch: app.fetch, port, hostname: host });
    let work: Promise<void> | undefined;
    const run = () => {
      if (!work)
        work = service
          .tick()
          .catch(() => {
            console.error(
              "Tool gate worker could not reconcile a request; reservations are retained",
            );
          })
          .finally(() => {
            work = undefined;
          });
    };
    const timer = setInterval(run, 1000);
    run();
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await work;
      db.close();
    };
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    console.log(
      `Tool gate listening on ${host}:${port}. Provider modes: ${providers.map((p) => p.mode).join(", ")}`,
    );
    return { service, server, close };
  } catch (error) {
    db.close();
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    startToolGate();
  } catch {
    console.error(
      "Tool gate startup failed. Check the configuration and private environment variables.",
    );
    process.exitCode = 1;
  }
}
