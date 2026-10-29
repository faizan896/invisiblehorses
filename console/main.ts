import "./style.css";
import type { ConsoleService } from "../src/console/service.js";
type Snapshot = ReturnType<ConsoleService["snapshot"]>;
type Payment = Snapshot["payments"][number];
const root = document.querySelector<HTMLDivElement>("#root")!;
let data: Snapshot | null = null,
  issuedKey: string | null = null,
  issuedKeyId: string | null = null,
  loading = false,
  lastRefresh = 0;
const view = () => location.hash.slice(1) || "overview";
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const dollars = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );
const time = (v: string | null | undefined) =>
  v
    ? new Date(v).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not yet";
const merchant = (id: string) =>
  id === "dataco" ? "DataCo" : id === "compute-co" ? "ComputeCo" : id;
const agent = (id: string) =>
  data?.agents.find((a) => a.id === id)?.name ?? "Agent";
const human = (v: string) =>
  v.replaceAll("_", " ").replace(/^./, (x) => x.toUpperCase());
function badge(status: string) {
  return `<span class="badge ${["completed", "available"].includes(status) ? "chosen" : ""}">${esc(human(status))}</span>`;
}
async function api<T>(path: string, body?: unknown, key?: string): Promise<T> {
  const result = await fetch("/console-api" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: key ? "omit" : "same-origin",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await result.json();
  if (!result.ok)
    throw Object.assign(
      new Error(json.error ?? "Request could not be completed"),
      { status: result.status },
    );
  return json as T;
}
function toast(message: string) {
  const e = document.querySelector("#toast")!;
  e.textContent = message;
  e.classList.add("visible");
  setTimeout(() => e.classList.remove("visible"), 5000);
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Clipboard unavailable. Select the text to copy it.");
  }
}
const nav = [
  ["overview", "Overview"],
  ["payments", "Payments"],
  ["approvals", "Approvals"],
  ["agents", "Agents & keys"],
  ["rules", "Spending rules"],
  ["developers", "Developers"],
  ["activity", "Activity"],
];
function themeButton() {
  const dark =
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme &&
      matchMedia("(prefers-color-scheme:dark)").matches);
  return `<button data-action="theme" type="button">${dark ? "Light" : "Dark"} mode</button>`;
}
function onboarding(message = "") {
  root.innerHTML = `<main class="onboarding"><header><a class="brand" href="/">Invisible Horses</a>${themeButton()}</header><p class="kicker">Spending controls for AI agents</p><h1>A budget for your agents.<br>A say in every payment.</h1><p>Create a private demo workspace and try the complete payment flow, from an agent request to a settled internal ledger entry.</p><ul><li>Issue a scoped agent API key.</li><li>Set budgets and require your approval above a limit.</li><li>Let a server-side worker finish accepted payments.</li></ul><div class="panel"><h2>Open your workspace</h2><p class="small">Free public demo. No account or bank connection required.</p><form id="onboard"><label for="workspace-name">Workspace name</label><input id="workspace-name" name="name" placeholder="Acme Studio" minlength="2" maxlength="60" required autocomplete="organization"/><p class="form-error" role="alert">${esc(message)}</p><div class="form-actions"><button class="primary" type="submit">Create demo workspace →</button></div></form></div><p class="small">Your workspace starts with $10,000 in internal demo credits. It is isolated from other visitors. Your access expires after seven days. Access stays in this browser through a secure session cookie.</p><footer>Working software with test credits. External bank and crypto payments are not connected. <a href="/playground/">Explore the route planner ↗</a></footer></main>`;
  bindCommon();
  document.querySelector("#onboard")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = (e.currentTarget as HTMLFormElement).querySelector(
      "button",
    )!;
    button.disabled = true;
    try {
      await api("/workspaces", {
        name: (document.querySelector("#workspace-name") as HTMLInputElement)
          .value,
      });
      await refresh();
      render();
    } catch (error) {
      document.querySelector(".form-error")!.textContent = (
        error as Error
      ).message;
      button.disabled = false;
    }
  });
}
function render() {
  if (!data) return;
  const d = data,
    pending = d.payments.filter((p) => p.status === "pending_approval").length;
  root.innerHTML = `<div class="layout"><aside class="sidebar"><div><a class="brand" href="/">Invisible Horses</a><span class="badge">Private demo</span></div><div class="workspace-name small">${esc(d.workspace.name)}</div><nav aria-label="Workspace">${nav.map(([id, label]) => `<a href="#${id}" ${view() === id ? 'aria-current="page"' : ""}>${label}${id === "approvals" && pending ? ` (${pending})` : ""}</a>`).join("")}</nav><div class="sidebar-bottom"><a href="/playground/">Route planner <span class="small">Preview ↗</span></a><a href="https://github.com/faizan896/railgate">Source & architecture ↗</a><span class="small">Internal demo credits.<br>No external money movement.</span></div></aside><main class="content"><div class="topbar"><p class="small">${esc(d.workspace.name)} / ${esc(nav.find((n) => n[0] === view())?.[1] ?? "Overview")}</p><div class="actions">${themeButton()}<a class="button mobile-nav" href="/playground/">Route planner</a><button data-action="refresh" type="button" aria-label="Refresh workspace">Refresh</button></div></div><div class="notice">Demo mode. Keys, spending rules, approvals and background processing work. Payments settle in an internal test ledger. Bank and USDC payouts are not connected.</div><div id="view"></div><footer class="page-footer">Workspace access expires ${time(d.workspace.expires_at)}. Daily budgets reset at 00:00 UTC. <a href="/console-api/export">Export your audit record</a>.</footer></main></div>`;
  const target = document.querySelector("#view")!;
  const v = view();
  target.innerHTML =
    v === "payments"
      ? paymentsView()
      : v === "approvals"
        ? approvalsView()
        : v === "agents"
          ? agentsView()
          : v === "rules"
            ? rulesView()
            : v === "developers"
              ? developersView()
              : v === "activity"
                ? activityView()
                : overviewView();
  bindCommon();
  bindView();
}
function heading(title: string, description: string, actions = "") {
  return `<div class="heading"><div><h1>${title}</h1><p class="muted">${description}</p></div>${actions ? `<div class="actions">${actions}</div>` : ""}</div>`;
}
function metrics() {
  const d = data!,
    completed = d.payments.filter((p) => p.status === "completed").length;
  return `<div class="metrics"><div class="metric"><p>Available demo credits</p><strong>${dollars(d.balance.available)}</strong><div class="small">${dollars(d.balance.reserved)} reserved</div></div><div class="metric"><p>Used or reserved today</p><strong>${dollars(d.balance.spent_today)}</strong><div class="small">of ${dollars(d.rules.daily)} daily budget</div></div><div class="metric"><p>Completed payments</p><strong>${completed}</strong><div class="small">Actual internal ledger entries</div></div><div class="metric"><p>Waiting for approval</p><strong>${d.payments.filter((p) => p.status === "pending_approval").length}</strong><div class="small">Your agents cannot approve these</div></div></div>`;
}
function paymentTable(payments: Payment[]) {
  if (!payments.length)
    return '<div class="empty">No payments yet. Create an agent key, then try your first payment.</div>';
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Payments"><table><thead><tr><th scope="col">Payment</th><th scope="col">Agent / vendor</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Created</th></tr></thead><tbody>${payments.map((p) => `<tr><td><button data-detail="${p.id}" type="button">${esc(p.purpose)}</button><span class="small">${esc(p.idempotency_key)}</span></td><td>${esc(agent(p.agent_id))}<span class="small">${esc(merchant(p.recipient))}</span></td><td>${dollars(p.amount)}<span class="small">USD demo credits</span></td><td>${badge(p.status)}</td><td class="small">${time(p.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
function overviewView() {
  const d = data!,
    active = d.keys.filter((k) => !k.revoked_at);
  return (
    heading(
      "Your agents can spend. You stay in control.",
      "Manage agent budgets, review requests and follow every payment.",
      `<button class="primary" data-action="payment">Try a payment</button>`,
    ) +
    metrics() +
    `<div class="two"><section class="section"><h2>Start with one agent</h2><ol class="steps"><li>${d.agents.length ? "Agent created" : "Create an agent"} <span class="small">${d.agents.length} in this workspace</span></li><li>${active.length ? "API key issued" : "Issue a scoped API key"} <span class="small">${active.length} active keys</span></li><li>${d.payments.length ? "First payment requested" : "Send a payment request"} <span class="small">A real API call with an idempotency key</span></li><li>${d.payments.some((p) => p.status === "completed") ? "Payment settled" : "Watch the background worker settle it"} <span class="small">Works after you close this tab</span></li></ol><button data-action="key">Create an agent key</button> <a href="#developers">Integration guide →</a></section><section class="section"><h2>Background worker</h2><p class="status-line"><span class="dot"></span>Server-side durable queue</p><p class="small">Last run: ${time(d.worker.last_run_at)}<br>Next scheduled run: ${time(d.worker.next_run_at)}</p><p class="small">Accepted payments reserve your budget. The worker rechecks the current rules and writes balanced ledger entries in one transaction.</p><p class="small">This page only reads status. It does not complete payments.</p></section></div><section class="section"><div class="between"><h2>Recent payments</h2><a href="#payments">View all →</a></div>${paymentTable(d.payments.slice(0, 5))}</section><section class="section"><h2>Connections</h2>${d.providers.map((p) => `<div class="list-row between"><div>${esc(p.name)}<p class="small">${p.id === "ledger" ? "Durable internal accounting with test credits" : "Requires a real provider account and integration"}</p></div>${badge(p.status)}</div>`).join("")}</section>`
  );
}
function paymentsView() {
  return (
    heading(
      "Payments",
      "Trace every request from policy check to final ledger entry.",
      `<button class="primary" data-action="payment">New demo payment</button>`,
    ) +
    `<label for="payment-filter" class="small">Show status</label><select id="payment-filter" style="max-width:260px"><option value="all">All payments</option>${["queued", "pending_approval", "completed", "denied", "rejected", "expired"].map((x) => `<option value="${x}">${human(x)}</option>`).join("")}</select><div id="payment-list">${paymentTable(data!.payments)}</div>`
  );
}
function approvalsView() {
  const pending = data!.payments.filter((p) => p.status === "pending_approval");
  return (
    heading(
      "Your approval comes first.",
      `Payments above ${dollars(data!.rules.approval_above)} need your decision. Approval expires after 15 minutes.`,
    ) +
    (pending.length
      ? pending
          .map(
            (p) =>
              `<article class="panel"><div class="between"><h2>${dollars(p.amount)} to ${esc(merchant(p.recipient))}</h2>${badge(p.status)}</div><p>${esc(p.purpose)}</p><p class="small">Requested by ${esc(agent(p.agent_id))}. Expires ${time(p.approval_expires_at)}.</p><p class="small">${esc(p.reasons.join(". "))}</p><div class="actions"><button class="primary" data-decision="approve" data-payment="${p.id}">Approve payment</button><button data-decision="reject" data-payment="${p.id}">Reject</button><button data-detail="${p.id}">View record</button></div></article>`,
          )
          .join("")
      : '<div class="empty">No payments need your approval. Try a $75 payment using the default rules.</div>')
  );
}
function issuedKeyView() {
  return issuedKey
    ? `<section class="key-box"><strong>Your new test API key</strong><p class="small">Copy it now. Only its hash is saved on the server. It will disappear from this page when you reload.</p><code id="issued-key">${esc(issuedKey)}</code><div class="actions"><button data-action="copy-key">Copy key</button><button data-action="dismiss-key">Hide key</button></div></section>`
    : "";
}
function agentsView() {
  const d = data!;
  return (
    heading(
      "Agents with clear boundaries.",
      "Each key belongs to one agent. Agent keys cannot change rules or approve payments.",
      `<button data-action="agent">Add agent</button><button class="primary" data-action="key">Create API key</button>`,
    ) +
    issuedKeyView() +
    `<section class="section"><h2>Agents</h2><div class="table-wrap" tabindex="0" role="region" aria-label="Agents"><table><thead><tr><th>Name</th><th>Per payment</th><th>Per day</th><th>Status</th></tr></thead><tbody>${d.agents.map((a) => `<tr><td>${esc(a.name)}<span class="small">${esc(a.id)}</span></td><td>${dollars(a.per_payment)}</td><td>${dollars(a.daily)}</td><td>${badge("active")}</td></tr>`).join("")}</tbody></table></div></section><section class="section"><h2>API keys</h2>${d.keys.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="API keys"><table><thead><tr><th>Name</th><th>Agent / permissions</th><th>Last used</th><th>Status</th><th>Action</th></tr></thead><tbody>${d.keys.map((k) => `<tr><td>${esc(k.name)}<span class="small">${esc(k.prefix)}</span></td><td>${esc(agent(k.agent_id))}<span class="small">${k.scopes.map(esc).join(", ")}</span></td><td class="small">${time(k.last_used_at)}</td><td>${badge(k.revoked_at ? "revoked" : "active")}</td><td>${k.revoked_at ? "" : `<button data-revoke="${k.id}">Revoke key</button>`}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No API keys yet. Create one to give an agent access.</div>'}</section>`
  );
}
function rulesView() {
  const r = data!.rules;
  return (
    heading(
      "Set the boundaries once.",
      "Rules are checked on every request and again before the background worker settles it.",
    ) +
    `<form id="rules-form" class="panel"><div class="form-grid"><div><label for="per-payment">Company limit per payment · USD</label><input id="per-payment" name="per_payment" type="number" min="0.01" max="1000000" step="0.01" value="${esc(r.per_payment)}" required/></div><div><label for="daily">Company daily budget · USD</label><input id="daily" name="daily" type="number" min="0.01" max="1000000" step="0.01" value="${esc(r.daily)}" required/></div><div class="full"><label for="approval-above">Require your approval above · USD</label><input id="approval-above" name="approval_above" type="number" min="0" max="1000000" step="0.01" value="${esc(r.approval_above)}" required/></div><fieldset class="full"><legend>Allowed demo vendors</legend><label class="check"><input name="merchants" type="checkbox" value="dataco" ${r.merchants.includes("dataco") ? "checked" : ""}/>DataCo · data and research</label><label class="check"><input name="merchants" type="checkbox" value="compute-co" ${r.merchants.includes("compute-co") ? "checked" : ""}/>ComputeCo · compute credits</label></fieldset></div><p class="small">The stricter of company and agent limits applies. Pending approvals and queued payments reserve budget. Denied, rejected and expired payments release it. Daily budgets use UTC; outstanding reservations continue to count across midnight.</p><p class="form-error" role="alert"></p><button class="primary" type="submit">Save spending rules</button></form>`
  );
}
const curlExample = () =>
  `export INVISIBLE_HORSES_API_KEY='paste_your_test_key_here'\n\ncurl '${location.origin}/console-api/v1/payments' \\\n  -H "Authorization: Bearer $INVISIBLE_HORSES_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '{\n    "idempotency_key": "invoice_demo_001",\n    "recipient": "dataco",\n    "amount": "12.50",\n    "purpose": "Research data invoice"\n  }'`;
const jsExample = () =>
  `const response = await fetch(\n  '${location.origin}/console-api/v1/payments',\n  {\n    method: 'POST',\n    headers: {\n      Authorization: \`Bearer \${process.env.INVISIBLE_HORSES_API_KEY}\`,\n      'Content-Type': 'application/json'\n    },\n    body: JSON.stringify({\n      idempotency_key: 'invoice_demo_001',\n      recipient: 'dataco',\n      amount: '12.50',\n      purpose: 'Research data invoice'\n    })\n  }\n);\nconst payment = await response.json();\n// GET /console-api/v1/payments/:id to read the outcome.\n// Retry the SAME payload with the SAME key after a timeout.`;
function developersView() {
  return (
    heading(
      "One API call. The controls stay with you.",
      "Use a scoped test key from your agent, script or backend. No model provider is required.",
    ) +
    issuedKeyView() +
    `<div class="actions"><button class="primary" data-action="key">Create a test API key</button><button data-action="copy-curl">Copy cURL</button></div><section class="section"><h2>Request a payment</h2><pre><code>${esc(curlExample())}</code></pre><details><summary>JavaScript example</summary><pre><code>${esc(jsExample())}</code></pre></details><p class="small">Amounts are decimal strings in USD. The response is HTTP 202 with a persisted payment record. Read its status to distinguish queued, pending approval, completed or denied. A completed payment means internal demo ledger settlement.</p></section><section class="section"><h2>Try the complete flow</h2><p>These buttons make real requests with your test key and current rules.</p><div class="actions"><button data-example="12.50">Try $12.50 payment</button><button data-example="75.00">Try $75 approval</button><button data-example="150.00">Try $150 limit check</button></div><p class="small">Default agent limit: $100 per payment, $500 per day. Default owner approval threshold: $50. Changed rules can produce different outcomes.</p></section><section class="section"><h2>API reference</h2><div class="table-wrap" tabindex="0"><table><thead><tr><th>Method / path</th><th>Permission</th><th>What it does</th></tr></thead><tbody><tr><td><code>POST /console-api/v1/payments</code></td><td>payments:write</td><td>Apply policy and persist an idempotent payment request.</td></tr><tr><td><code>GET /console-api/v1/payments</code></td><td>payments:read</td><td>List only this agent's payments.</td></tr><tr><td><code>GET /console-api/v1/payments/:id</code></td><td>payments:read</td><td>Read a payment and its current state.</td></tr></tbody></table></div><p class="small">401: invalid, expired or revoked key. 403: missing permission. 409: idempotency conflict or demo capacity reached. 400: invalid request. Policy denials are recorded payment outcomes, not transport errors.</p></section><section class="section"><h2>Idempotency is part of the contract.</h2><p>The same agent, idempotency key and payload return the original payment. A different payload with that key returns 409. New logical invoices need new keys.</p><p class="small">Keys expire with this seven-day workspace. Only hashes are stored. Keep keys in server-side environment variables and revoke unused ones.</p></section>`
  );
}
function activityView() {
  return (
    heading(
      "Every decision leaves a record.",
      "Actual append-only events from this workspace.",
      `<a class="button" href="/console-api/export">Export JSON</a>`,
    ) +
    `<div class="table-wrap" tabindex="0" role="region" aria-label="Audit events"><table><thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Details</th></tr></thead><tbody>${data!.audit
      .map((x) => {
        const a = x as {
          created_at: string;
          event: string;
          actor: string;
          details: unknown;
        };
        return `<tr><td class="small">${time(a.created_at)}</td><td>${esc(human(a.event.replaceAll(".", " ")))}</td><td class="small">${esc(a.actor === "owner" ? "Workspace owner" : a.actor === "worker" ? "Background worker" : a.actor === "policy" ? "Policy engine" : agent(a.actor))}</td><td><code>${esc(JSON.stringify(a.details))}</code></td></tr>`;
      })
      .join("")}</tbody></table></div>`
  );
}
function modal(title: string, content: string) {
  document.querySelector("dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `<header><h2>${esc(title)}</h2><button data-close type="button" aria-label="Close dialog">Close</button></header>${content}`;
  document.body.append(dialog);
  dialog
    .querySelector("[data-close]")!
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  return dialog;
}
function formTask(
  form: HTMLFormElement,
  run: (values: FormData) => Promise<void>,
) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector<HTMLButtonElement>(
      "button[type=submit]",
    )!;
    button.disabled = true;
    const err = form.querySelector(".form-error");
    if (err) err.textContent = "";
    try {
      await run(new FormData(form));
    } catch (error) {
      if (err) err.textContent = (error as Error).message;
      else toast((error as Error).message);
    } finally {
      button.disabled = false;
    }
  });
}
function keyModal() {
  if (!data) return;
  const dialog = modal(
    "Give an agent access.",
    `<p class="small">A test key can request or read payments. It cannot approve spending or change rules.</p><form><label for="key-agent">Agent</label><select name="agent_id" id="key-agent">${data.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select><label for="key-name">Key name</label><input id="key-name" name="name" value="Development key" minlength="2" maxlength="60" required/><label class="check"><input name="scopes" type="checkbox" value="payments:read" checked/>Read this agent's payments</label><label class="check"><input name="scopes" type="checkbox" value="payments:write" checked/>Request payments</label><p class="form-error" role="alert"></p><button class="primary" type="submit">Create test key</button></form>`,
  );
  formTask(dialog.querySelector("form")!, async (f) => {
    const result = await api<{ key: string; id: string }>("/keys", {
      agent_id: f.get("agent_id"),
      name: f.get("name"),
      scopes: f.getAll("scopes"),
    });
    issuedKey = result.key;
    issuedKeyId = result.id;
    dialog.close();
    location.hash = "agents";
    await refresh();
    toast("Key created. Copy it now; it is only shown once.");
  });
}
function agentModal() {
  const dialog = modal(
    "Add an agent",
    `<form><div class="form-grid"><div class="full"><label for="agent-name">Agent name</label><input id="agent-name" name="name" placeholder="Research agent" minlength="2" maxlength="60" required/></div><div><label for="agent-per">Per payment · USD</label><input id="agent-per" name="per_payment" type="number" min="0.01" step="0.01" max="1000000" value="100.00" required/></div><div><label for="agent-day">Daily budget · USD</label><input id="agent-day" name="daily" type="number" min="0.01" step="0.01" max="1000000" value="500.00" required/></div></div><p class="form-error" role="alert"></p><button class="primary" type="submit">Create agent</button></form>`,
  );
  formTask(dialog.querySelector("form")!, async (f) => {
    await api("/agents", {
      name: f.get("name"),
      per_payment: Number(f.get("per_payment")).toFixed(2),
      daily: Number(f.get("daily")).toFixed(2),
    });
    dialog.close();
    await refresh();
    toast("Agent created.");
  });
}
function paymentModal(amount = "12.50") {
  const dialog = modal(
    "Request a demo payment",
    `<p class="small">This form uses an agent key, just like an external integration. Owner permissions are not sent with the request.</p><form><div class="form-grid"><div class="full"><label for="pay-key">Agent test API key</label><input id="pay-key" name="key" type="password" value="${esc(issuedKey ?? "")}" placeholder="rg_test.…" autocomplete="off" required/><p class="small">No key yet? <button data-mint-key type="button">Create one</button></p></div><div><label for="pay-vendor">Demo vendor</label><select id="pay-vendor" name="recipient"><option value="dataco">DataCo</option><option value="compute-co">ComputeCo</option></select></div><div><label for="pay-amount">Amount · USD demo credits</label><input id="pay-amount" name="amount" type="number" min="0.01" max="1000000" step="0.01" value="${esc(amount)}" required/></div><div class="full"><label for="pay-purpose">What is this for?</label><input id="pay-purpose" name="purpose" value="Research data invoice" maxlength="300" required/></div><div class="full"><label for="pay-idem">Idempotency key</label><input id="pay-idem" name="idempotency_key" value="invoice_${crypto.randomUUID().slice(0, 8)}" pattern="[a-zA-Z0-9_-]{1,100}" maxlength="100" required/><p class="small">Reuse this key for a retry. Use a new one for a new invoice.</p></div></div><p class="form-error" role="alert"></p><button class="primary" type="submit">Send agent request →</button></form>`,
  );
  dialog.querySelector("[data-mint-key]")!.addEventListener("click", () => {
    dialog.close();
    keyModal();
  });
  formTask(dialog.querySelector("form")!, async (f) => {
    const p = await api<Payment>(
      "/v1/payments",
      {
        recipient: f.get("recipient"),
        amount: Number(f.get("amount")).toFixed(2),
        purpose: f.get("purpose"),
        idempotency_key: f.get("idempotency_key"),
      },
      String(f.get("key")),
    );
    dialog.close();
    location.hash = "payments";
    await refresh();
    paymentDetail(p.id);
  });
}
function paymentDetail(id: string) {
  const p = data?.payments.find((x) => x.id === id);
  if (!p) return;
  const events = data!.audit
    .filter((x) => (x as { payment_id?: string }).payment_id === id)
    .reverse();
  modal(
    "Payment record",
    `<div class="between"><h3>${dollars(p.amount)} to ${esc(merchant(p.recipient))}</h3>${badge(p.status)}</div><p>${esc(p.purpose)}</p><div class="detail-grid"><div><small>Requested by</small>${esc(agent(p.agent_id))}</div><div><small>Route</small>${esc(p.route ?? "No eligible route")}</div><div><small>Payment ID</small><code>${esc(p.id)}</code></div><div><small>Idempotency key</small><code>${esc(p.idempotency_key)}</code></div><div><small>Created</small>${time(p.created_at)}</div><div><small>Last update</small>${time(p.updated_at)}</div></div><p class="notice">${esc(p.reasons.join(". "))}</p><p class="small">${p.status === "queued" ? "The durable background worker will process this request even after you close this page." : p.status === "completed" ? "This is an internal ledger receipt. No bank funds or crypto tokens moved." : "Your budget and approval rules determine the next step."}</p><h3>Event history</h3><ol class="timeline">${events
      .map((x) => {
        const e = x as { event: string; created_at: string };
        return `<li><p>${esc(human(e.event.replaceAll(".", " ")))}</p><small>${time(e.created_at)}</small></li>`;
      })
      .join(
        "",
      )}</ol><p class="small">Close this record and refresh to see its latest state.</p>`,
  );
}
function bindCommon() {
  document.querySelectorAll("[data-action=theme]").forEach((b) =>
    b.addEventListener("click", () => {
      const dark = b.textContent?.includes("Light");
      document.documentElement.dataset.theme = dark ? "light" : "dark";
      try {
        localStorage.setItem(
          "payroute-theme",
          document.documentElement.dataset.theme,
        );
      } catch {
        /* Theme works without storage. */
      }
      b.textContent = dark ? "Dark mode" : "Light mode";
    }),
  );
}
function bindView() {
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((b) =>
    b.addEventListener("click", () => {
      const a = b.dataset.action;
      if (a === "refresh") void refresh(true);
      if (a === "key") keyModal();
      if (a === "agent") agentModal();
      if (a === "payment") paymentModal();
      if (a === "copy-key" && issuedKey) void copy(issuedKey);
      if (a === "copy-curl") void copy(curlExample());
      if (a === "dismiss-key") {
        issuedKey = null;
        issuedKeyId = null;
        render();
      }
    }),
  );
  document
    .querySelectorAll<HTMLButtonElement>("[data-example]")
    .forEach((b) =>
      b.addEventListener("click", () => paymentModal(b.dataset.example)),
    );
  bindPayments();
  document.querySelector("#payment-filter")?.addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value;
    document.querySelector("#payment-list")!.innerHTML = paymentTable(
      data!.payments.filter((p) => value === "all" || p.status === value),
    );
    bindPayments();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-revoke]").forEach((b) =>
    b.addEventListener("click", () => {
      const dialog = modal(
        "Revoke this key?",
        `<p>New requests using this key will be rejected immediately. Already accepted payments keep their existing approval and policy checks.</p><button class="primary" id="confirm-revoke">Revoke key</button>`,
      );
      dialog
        .querySelector("#confirm-revoke")!
        .addEventListener("click", async () => {
          try {
            await api(`/keys/${b.dataset.revoke}/revoke`, {});
            if (issuedKeyId === b.dataset.revoke) {
              issuedKey = null;
              issuedKeyId = null;
            }
            dialog.close();
            await refresh();
            toast("Key revoked.");
          } catch (error) {
            toast((error as Error).message);
          }
        });
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-decision]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const p = await api<Payment>(
          `/payments/${b.dataset.payment}/decision`,
          { action: b.dataset.decision },
        );
        await refresh();
        toast(`Payment ${human(p.status).toLowerCase()}.`);
      } catch (error) {
        toast((error as Error).message);
        b.disabled = false;
      }
    }),
  );
  const rules = document.querySelector<HTMLFormElement>("#rules-form");
  if (rules)
    formTask(rules, async (f) => {
      await api("/rules", {
        per_payment: Number(f.get("per_payment")).toFixed(2),
        daily: Number(f.get("daily")).toFixed(2),
        approval_above: Number(f.get("approval_above")).toFixed(2),
        merchants: f.getAll("merchants"),
      });
      await refresh();
      toast("Spending rules saved.");
    });
}
function bindPayments() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-detail]")
    .forEach((b) =>
      b.addEventListener("click", () => paymentDetail(b.dataset.detail!)),
    );
}
async function refresh(showToast = false) {
  if (loading) return;
  loading = true;
  try {
    data = await api<Snapshot>("/session");
    lastRefresh = Date.now();
    if (
      !document.querySelector("dialog[open]") &&
      !(document.activeElement instanceof HTMLInputElement) &&
      !(document.activeElement instanceof HTMLSelectElement)
    )
      render();
    if (showToast) toast("Workspace refreshed.");
  } catch (error) {
    if ((error as { status: number }).status === 401) {
      data = null;
      issuedKey = null;
      onboarding(
        lastRefresh
          ? "Your demo session has expired. Create a new workspace to continue."
          : "",
      );
    } else if (!data) onboarding((error as Error).message);
    else toast((error as Error).message);
  } finally {
    loading = false;
  }
}
window.addEventListener("hashchange", () => {
  if (data) render();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
setInterval(() => {
  if (
    !data ||
    document.hidden ||
    document.querySelector("dialog[open]") ||
    ["rules", "agents", "developers"].includes(view())
  )
    return;
  const busy = data.payments.some(
    (p) => p.status === "queued" || p.status === "pending_approval",
  );
  if (busy || Date.now() - lastRefresh > 15000) void refresh();
}, 3000);
void refresh();
