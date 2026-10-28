import "./style.css";
import {
  createRouter,
  Counterparties,
  PolicySchema,
  PaymentIntentV2Schema,
  type Scoring,
  type RoutePlan,
  type RouteQuote,
  type Alternative,
} from "../src/index.js";
import catalog from "../examples/counterparties.json" with { type: "json" };
import reference from "./reference.json" with { type: "json" };
import {
  defaults,
  settings,
  sources,
  checked,
  playgroundAdapters,
  easternDay,
  holiday,
  working,
  atEastern,
  type Values,
} from "./model.js";

const profiles = new Counterparties(catalog);
const form = document.querySelector<HTMLFormElement>("#intent-form")!;
const field = (id: string) =>
  document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
const names: Record<string, string> = {
  ledger: "Internal account",
  "ach-mock": "ACH bank transfer",
  "usdc-base-sepolia": "USDC",
  "wise-quote": "Bank transfer",
};
const descriptions: Record<string, string> = {
  ledger: "Test ledger",
  "ach-mock": "Simulated US bank",
  "usdc-base-sepolia": "Base Sepolia test tokens",
  "wise-quote": "Generic model, not a Wise quote",
};
const initial = (): Values => ({
  ...defaults(),
  mxn: reference.mxn,
  eur: reference.eur,
});
let values = initial();
let revision = 0;
const money = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
const date = (v: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(Math.ceil(Date.parse(v) / 60000) * 60000)) + " UTC";
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
) {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}
function tag(
  kind: "assumption" | "published" | "live",
  reason: string,
  url?: string,
  name?: string,
  stamp = checked,
) {
  const wrap = element("span", "source-wrap"),
    button = element(
      "button",
      "source-tag",
      kind === "published" ? `published · ${name} · ${stamp}` : kind,
    );
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  const note = element("span", "source-note");
  note.id = `source-${crypto.randomUUID()}`;
  button.setAttribute("aria-controls", note.id);
  note.append(element("p", "", reason));
  if (url) {
    const link = element("a", "", `Open ${name ?? "source"} ↗`);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    note.append(link);
  }
  button.addEventListener("click", () => {
    const open = !wrap.classList.contains("open");
    document.querySelectorAll(".source-wrap.open").forEach((e) => {
      e.classList.remove("open");
      e.querySelector("button")?.setAttribute("aria-expanded", "false");
    });
    wrap.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      wrap.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
      button.focus();
    }
  });
  wrap.append(button, note);
  return wrap;
}
const assumption = (
  reason = "Calculated from the editable assumptions below. This is test data, not a provider quote.",
) => tag("assumption", reason);
function attachSource(label: HTMLLabelElement, badge: HTMLElement) {
  const line = element("div", "label-line");
  label.replaceWith(line);
  line.append(label, badge);
}
function fxTag(id: string) {
  return values[id] === initial()[id]
    ? tag(
        "published",
        "ECB daily reference cross-rate, rounded to six decimal places. Informational reference, not an executable exchange rate. Derived as MXN/EUR divided by USD/EUR, or 1 divided by USD/EUR.",
        reference.source,
        "ECB",
        reference.date,
      )
    : assumption("Visitor override of the ECB reference rate.");
}
function cost(q: RouteQuote) {
  const principal = Number(q.principal_usd),
    fees = Number(q.total_fee_usd),
    fraction = q.rail === "ledger" ? 0 : values.variation! / 100;
  const low = principal + fees * (1 - fraction),
    high = principal + fees * (1 + fraction);
  return Math.round(low * 100) === Math.round(high * 100)
    ? money(low)
    : `${money(low)}–${money(high)}`;
}
function duration(now: string, then: string) {
  const minutes = Math.ceil((Date.parse(then) - Date.parse(now)) / 60000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in about ${minutes} min`;
  const hours = Math.max(1, Math.round(minutes / 60));
  return hours < 48
    ? `in about ${hours} hours`
    : `in about ${Math.ceil(hours / 24)} days`;
}
function plain(reason: string) {
  return reason
    .replaceAll(
      "Recipient requested a different funds form",
      "Does not deliver to the selected account type",
    )
    .replaceAll(
      "Recipient, currency or corridor is unsupported on this rail",
      "Recipient, currency or destination is unsupported",
    )
    .replaceAll(
      "Rail does not deliver the form requested by the recipient",
      "Does not deliver to the selected account type",
    )
    .replaceAll(
      "Bank/rail is outside its operating window or after cutoff",
      "Outside the assumed bank hours or past cutoff",
    )
    .replaceAll(
      "Latest recipient funds availability misses the deadline",
      "May arrive after your deadline",
    )
    .replaceAll("All-in fees exceed max_fee", "Fees exceed your maximum")
    .replaceAll(
      "KYB gate: both test counterparty profiles must be verified",
      "Both fictional businesses must pass verification",
    )
    .replaceAll("new_merchant_max", "new recipient limit")
    .replaceAll("—", ",");
}
function why(a: Alternative, selected: RouteQuote | null) {
  if (selected?.id === a.quote?.id) return "Chosen";
  if (a.reasons.length) return a.reasons.map(plain).join(". ");
  return field("scoring").value === "fastest"
    ? "Arrives later, or loses the cost tie-break"
    : field("scoring").value === "most-certain"
      ? "Less reversible or loses the certainty tie-break"
      : "Costs more, or loses the arrival tie-break";
}
function render(plan: RoutePlan, now: string, deadline: string) {
  const q = plan.selected,
    chosen = element("article", "recommendation");
  chosen.append(element("p", "small", "Recommended route"));
  if (q) {
    const title = element(
      "h2",
      "",
      `Send via ${names[q.rail]}: ${cost(q)} all-in, arrives ${duration(now, q.expected_available_at)}`,
    );
    title.append(
      assumption(
        "Total USD debit includes principal and fees. The range uses your editable external-fee variation. Arrival and certainty are modeled; the router selects using the central cost and latest planning arrival.",
      ),
    );
    chosen.append(title);
    const strategy =
      field("scoring").value === "fastest"
        ? "It has the earliest expected arrival among routes that meet your constraints."
        : field("scoring").value === "most-certain"
          ? "It wins on refunds and model certainty among routes that meet your constraints."
          : "It has the lowest central cost among routes that meet your deadline and account preference.";
    chosen.append(element("p", "", strategy));
    const fees = element(
      "p",
      "small",
      `Central estimate ${money(Number(q.total_all_in_cost.amount))}: ${money(Number(q.principal_usd))} principal + ${money(Number(q.total_fee_usd))} fees.`,
    );
    fees.append(assumption());
    chosen.append(fees);
    if (q.destination_form === "bank" && q.rail === "usdc-base-sepolia")
      chosen.append(
        element(
          "p",
          "small",
          "Arrival means usable bank funds after the modeled payout, not chain confirmation.",
        ),
      );
    if (plan.decision === "needs_approval")
      chosen.append(
        element(
          "p",
          "small",
          "Owner approval would be required before sending. This page cannot approve or send payments.",
        ),
      );
  } else {
    chosen.append(
      element("h2", "", "No route meets these constraints."),
      element("p", "", plan.reasons.map(plain).join(". ")),
    );
  }
  document.querySelector("#chosen")!.replaceChildren(chosen);
  const rows = plan.alternatives.map((a) => {
    const row = element("tr", q && a.quote?.id === q.id ? "selected" : "");
    const name = element("td");
    name.append(
      element("span", "", names[a.rail] ?? a.rail),
      element("small", "", descriptions[a.rail] ?? "Test route"),
    );
    row.append(name);
    if (a.quote) {
      const x = a.quote,
        price = element("td", "", cost(x));
      price.append(
        assumption(),
        element(
          "small",
          "",
          `Central ${money(Number(x.total_all_in_cost.amount))}`,
        ),
      );
      const breakdown = element("details");
      breakdown.append(element("summary", "", "Fee breakdown"));
      for (const f of x.fees_usd) {
        const p = element(
          "p",
          "small",
          `${{ fx_spread: "Exchange markup", network: "Network", onramp: "Funding", offramp: "Bank payout", bank: "Bank fee", service: "Service fee" }[f.kind]}: ${money(Number(f.amount))}`,
        );
        p.append(assumption());
        breakdown.append(p);
      }
      price.append(breakdown);
      const arrival = element("td", "", date(x.expected_available_at));
      if (x.latest_available_at !== x.expected_available_at)
        arrival.append(
          element("small", "", `Up to ${date(x.latest_available_at)}`),
        );
      arrival.append(
        assumption(
          "Planning arrival from editable waits, bank working hours and the published US holiday calendar. It is not a provider delivery promise.",
        ),
      );
      const certainty = element(
        "td",
        "",
        `${Math.round(x.certainty * 100)}% model score`,
      );
      certainty.append(
        assumption(
          "Uncalibrated assumption, not a measured success probability.",
        ),
        element(
          "small",
          "",
          x.reversibility === "reversible"
            ? "Can be undone"
            : x.reversibility === "conditional"
              ? "Refunds may be possible"
              : "Cannot be undone",
        ),
      );
      row.append(price, arrival, certainty);
    } else
      for (let i = 0; i < 3; i++)
        row.append(element("td", "small", "Unavailable"));
    row.append(element("td", "", why(a, q)));
    return row;
  });
  document.querySelector("#quotes")!.replaceChildren(...rows);
  renderTimeline(plan, now, deadline);
}
function renderTimeline(plan: RoutePlan, now: string, deadline: string) {
  const root = element("div", "timeline");
  const start = Date.parse(now),
    end = Date.parse(deadline);
  if (end <= start) {
    document.querySelector("#timeline")!.replaceChildren();
    return;
  }
  const position = (n: number) =>
    Math.max(0, Math.min(100, ((n - start) / (end - start)) * 100));
  const axis = element("div", "timeline-axis");
  axis.append(element("span", "small", "UTC"));
  const axisLine = element("div", "axis");
  axisLine.append(
    element("span", "", `Now · ${date(now)}`),
    element("span", "", `Deadline · ${date(deadline)}`),
  );
  axis.append(axisLine);
  root.append(axis);
  const bands: { left: number; width: number; kind: string; title: string }[] =
    [];
  const cutoffs: number[] = [];
  let day = easternDay(new Date(now));
  for (
    let i = 0;
    i < 370 && Date.parse(atEastern(day, 0)) < end;
    i++, day = new Date(day.getTime() + 86400000)
  ) {
    const d0 = Date.parse(atEastern(day, 0)),
      d1 = Date.parse(atEastern(new Date(day.getTime() + 86400000), 0));
    const push = (a: number, b: number, kind: string, title: string) => {
      const left = position(a),
        right = position(b);
      if (right > left) bands.push({ left, width: right - left, kind, title });
    };
    if (!working(day))
      push(
        d0,
        d1,
        holiday(day) ? "holiday" : "weekend",
        holiday(day) ? "US bank holiday" : "Weekend",
      );
    else {
      const opening = Date.parse(atEastern(day, values.open!)),
        cutoff = Date.parse(atEastern(day, values.cutoff!));
      push(d0, opening, "closed", "Before assumed bank opening");
      push(cutoff, d1, "closed", "After assumed customer bank cutoff");
      if (cutoff > start && cutoff < end) cutoffs.push(position(cutoff));
    }
  }
  for (const a of plan.alternatives) {
    const row = element("div", "timeline-row");
    const label = element("div", "", names[a.rail] ?? a.rail);
    label.append(
      element(
        "span",
        "small",
        a.quote ? duration(now, a.quote.expected_available_at) : "Unavailable",
      ),
    );
    const track = element("div", "track");
    track.setAttribute("role", "img");
    track.setAttribute(
      "aria-label",
      a.quote
        ? `${names[a.rail]} expected ${date(a.quote.expected_available_at)}, latest ${date(a.quote.latest_available_at)}. ${a.eligible ? "Eligible" : "Rejected by constraints"}`
        : `${names[a.rail]} unavailable`,
    );
    for (const b of bands) {
      const shade = element("span", `shade ${b.kind}`);
      shade.style.left = b.left + "%";
      shade.style.width = b.width + "%";
      shade.title = b.title;
      track.append(shade);
    }
    for (const c of cutoffs) {
      const line = element("span", "cutoff");
      line.style.left = c + "%";
      line.title = "Assumed bank cutoff";
      track.append(line);
    }
    if (a.quote) {
      const x = position(Date.parse(a.quote.expected_available_at)),
        last = position(Date.parse(a.quote.latest_available_at));
      const range = element("span", "arrival-range");
      range.style.left = x + "%";
      range.style.width = last - x + "%";
      const dot = element("span", "arrival");
      dot.style.left = `clamp(6px, ${x}%, calc(100% - 6px))`;
      dot.title = `${date(a.quote.expected_available_at)}${Date.parse(a.quote.expected_available_at) > end ? " (after deadline)" : ""}`;
      track.append(range, dot);
      if (Date.parse(a.quote.latest_available_at) > end)
        label.append(element("span", "small", "After deadline →"));
    }
    row.append(label, track);
    root.append(row);
  }
  root.append(
    element(
      "p",
      "small",
      "Dots show expected arrival; bars extend to the latest planning arrival. Rejected routes stay visible.",
    ),
  );
  const legend = element("div", "legend");
  legend.append(
    element("span", "", "Closed bank hours / weekend"),
    element("span", "", "Hatched: US bank holiday"),
  );
  root.append(legend);
  const note = element(
    "p",
    "small",
    `Customer cutoff ${values.cutoff}:00 Eastern.`,
  );
  note.append(
    assumption("Editable customer cutoff, not a FedACH operator deadline."),
    tag(
      "published",
      sources.holidays.reason,
      sources.holidays.url,
      sources.holidays.name,
    ),
  );
  root.append(note);
  document.querySelector("#timeline")!.replaceChildren(root);
}
function readValues() {
  const result: Values = {};
  for (const s of settings) {
    const input = field(`a-${s.id}`) as HTMLInputElement;
    if (!input.checkValidity() || input.value === "")
      throw new Error(`Check ${s.label.toLowerCase()}.`);
    result[s.id] = Number(input.value);
  }
  if (result.mxn! <= 0 || result.eur! <= 0)
    throw new Error("Exchange rates must be greater than zero.");
  if (result.open! >= result.cutoff!)
    throw new Error("Bank opening must be earlier than cutoff.");
  if (result.reopen! < result.open! || result.reopen! >= result.cutoff!)
    throw new Error(
      "Payout reopening hour must be within the bank working window.",
    );
  if (result.bankLatest! < result.bankExpected!)
    throw new Error("Latest wait must be at least the expected wait.");
  if (result.validity! <= 0) throw new Error("Plan validity must be positive.");
  return result;
}
async function update() {
  const id = ++revision;
  document.querySelector(".results")!.setAttribute("aria-busy", "true");
  try {
    values = readValues();
    document.querySelector("#assumption-error")!.textContent = "";
    const now = `${field("send").value}:00Z`,
      deadline = `${field("deadline").value}:00Z`,
      currency = field("currency").value;
    if (!form.checkValidity())
      throw new Error(
        "Use a positive amount with at most two decimals and valid dates.",
      );
    if (
      Date.parse(deadline) <= Date.parse(now) ||
      Date.parse(deadline) - Date.parse(now) > 366 * 86400000
    )
      throw new Error("Choose a deadline after sending and within one year.");
    const bankTime = document.querySelector("#bank-time")!;
    bankTime.replaceChildren(
      element(
        "span",
        "",
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(new Date(now)) +
          ` · customer cutoff ${values.cutoff}:00 Eastern`,
      ),
      assumption(
        "Send time is your scenario input. Customer cutoff is editable and is not a universal bank rule.",
      ),
    );
    const usd = (id: string) => values[id]!.toFixed(2);
    const policy = PolicySchema.parse({
      max_per_payment: usd("paymentLimit"),
      max_per_day: usd("dailyLimit"),
      new_merchant_max: usd("paymentLimit"),
      require_approval_above: usd("approval"),
      expires_at: `${values.expiryYear}-01-01T00:00:00Z`,
      allowed_merchants: [
        { id: "dataco" },
        { id: "norte" },
        { id: "euro-data" },
      ],
      routing: { min_certainty: values.minimumCertainty! / 100 },
    });
    const intent = PaymentIntentV2Schema.parse({
      idempotency_key: "playground-preview",
      payer: "research-agent-07",
      recipient:
        currency === "MXN"
          ? "norte"
          : currency === "EUR"
            ? "euro-data"
            : "dataco",
      amount: field("amount").value,
      destination_currency: currency,
      deadline,
      purpose: "Playground preview",
      max_fee: field("max-fee").value,
      reversibility_requirement: field("reversibility").value,
      recipient_preferences: {
        delivery: field("delivery").value,
        avoid_stablecoins: (field("avoid-stablecoins") as HTMLInputElement)
          .checked,
      },
    });
    const router = createRouter({
      rails: playgroundAdapters({ ...values }),
      scoring: field("scoring").value as Scoring,
      context: (i) => ({
        payer: profiles.get(i.payer),
        recipient: profiles.get(i.recipient),
        policy,
        history: { now, spent_today: usd("spent"), paid_merchants: [] },
      }),
    });
    const plan = await router.plan(intent);
    if (id === revision) {
      render(plan, now, deadline);
      renderAudit();
    }
  } catch (error) {
    if (id !== revision) return;
    const card = element("article", "recommendation");
    card.append(
      element("h2", "", "Check your inputs."),
      element(
        "p",
        "",
        error instanceof Error && !error.message.startsWith("[")
          ? error.message
          : "Use valid amounts, dates and assumption values.",
      ),
    );
    document.querySelector("#chosen")!.replaceChildren(card);
    document.querySelector("#quotes")!.replaceChildren();
    document.querySelector("#timeline")!.replaceChildren();
    document.querySelector("#assumption-error")!.textContent =
      "Fix the highlighted inputs or reset assumptions to recalculate.";
  } finally {
    if (id === revision)
      document.querySelector(".results")!.setAttribute("aria-busy", "false");
  }
}
function renderSettings() {
  const rows = settings.map((s) => {
    const row = element("div", "assumption-row");
    const label = element("label", "", s.label);
    label.htmlFor = `a-${s.id}`;
    label.append(element("span", "unit", ` · ${s.unit}`));
    const labelLine = element("div", "label-line");
    labelLine.append(
      label,
      s.id === "mxn" || s.id === "eur" ? fxTag(s.id) : assumption(s.reason),
    );
    const input = element("input");
    input.id = `a-${s.id}`;
    input.type = "number";
    input.value = String(values[s.id]);
    input.min = String(s.min ?? 0);
    input.max = String(s.max);
    input.step = s.id === "mxn" || s.id === "eur" ? "0.000001" : String(s.step);
    input.required = true;
    const reason = element(
      "p",
      "small",
      s.id === "mxn" || s.id === "eur"
        ? "ECB reference rate by default. Editing makes this an assumption."
        : s.reason,
    );
    reason.id = `reason-${s.id}`;
    input.setAttribute("aria-describedby", reason.id);
    row.append(labelLine, input, reason);
    return row;
  });
  document.querySelector("#assumption-fields")!.replaceChildren(...rows);
  document.querySelector("#assumption-count")!.textContent =
    `(${settings.length})`;
}
function renderAudit() {
  for (const id of ["mxn", "eur"]) {
    const label = document.querySelector(`label[for="a-${id}"]`);
    label?.parentElement?.querySelector(".source-wrap")?.remove();
    label?.parentElement?.append(fxTag(id));
  }
  const rows = settings.map((s) => {
    const row = element("tr");
    const origin = element(
      "td",
      "small",
      s.id === "mxn" || s.id === "eur"
        ? "ECB daily reference or visitor override."
        : s.reason,
    );
    origin.append(
      s.id === "mxn" || s.id === "eur" ? fxTag(s.id) : assumption(s.reason),
    );
    row.append(
      element("td", "", s.label),
      element("td", "", `${values[s.id]} ${s.unit}`),
      origin,
    );
    return row;
  });
  const extra = [
    [
      "All-in total",
      "Principal + fees",
      "Computed from the rate and each fee above. Ranges apply the editable fee variation; ranking uses the central estimate.",
    ],
    [
      "Expected / latest arrival",
      "Shown per route",
      "Derived from the send time, editable waits and bank hours, and the published US holiday calendar.",
    ],
  ];
  for (const [name, value, reason] of extra) {
    const row = element("tr"),
      cell = element("td", "small", reason);
    cell.append(assumption(reason));
    row.append(element("td", "", name), element("td", "", value), cell);
    rows.push(row);
  }
  document.querySelector("#audit")!.replaceChildren(...rows);
}
function renderSources() {
  document.querySelector("#checked")!.textContent =
    `Prices last checked: ${checked}. ECB reference date: ${reference.date}.`;
  const rules = Object.values(sources).map((s) => {
    const p = element("p", "rule", s.reason);
    p.append(tag("published", s.reason, s.url, s.name));
    return p;
  });
  document.querySelector("#public-sources")!.replaceChildren(...rules);
}
async function liveData() {
  const root = document.querySelector("#live-data")!;
  root.textContent = "Checking current Base mainnet gas…";
  try {
    const response = await fetch("https://mainnet.base.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_gasPrice",
        params: [],
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error();
    const data = (await response.json()) as { result?: string };
    if (!data.result || !/^0x[0-9a-f]+$/i.test(data.result)) throw new Error();
    const gwei = Number(BigInt(data.result)) / 1e9;
    if (!Number.isFinite(gwei) || gwei <= 0) throw new Error();
    root.replaceChildren(
      element(
        "span",
        "",
        `Base mainnet gas price: ${gwei.toPrecision(2)} gwei. `,
      ),
      tag(
        "live",
        `eth_gasPrice from Base mainnet, retrieved ${new Date().toISOString()}. Execution gas price only. Excludes gas units, L1 data, operator fees and ETH/USD conversion. Not used as a complete transfer price.`,
        "https://mainnet.base.org",
        "Base RPC",
      ),
      element(
        "p",
        "",
        "The editable USD network allowance remains an assumption. Mainnet gas is a reference for planning; the modeled route uses Base Sepolia test tokens.",
      ),
    );
  } catch {
    root.textContent =
      "Live Base gas is unavailable. The editable network allowance is still an assumption; no cached reading is presented as live.";
  }
}
const scenarios: Record<string, Record<string, string>> = {
  domestic: {
    amount: "10.00",
    currency: "USD",
    delivery: "any",
    send: "2026-10-27T14:00",
  },
  monday: {
    amount: "250000.00",
    currency: "MXN",
    delivery: "bank",
    send: "2026-10-26T22:00",
  },
  tuesday: {
    amount: "250000.00",
    currency: "MXN",
    delivery: "bank",
    send: "2026-10-27T14:00",
  },
  refund: {
    amount: "25.00",
    currency: "USD",
    delivery: "any",
    send: "2026-10-27T14:00",
    scoring: "most-certain",
    reversibility: "preferred",
  },
  weekend: {
    amount: "10.00",
    currency: "USD",
    delivery: "bank",
    send: "2026-10-31T14:00",
  },
  holiday: {
    amount: "10.00",
    currency: "USD",
    delivery: "bank",
    send: "2026-11-26T15:00",
    deadline: "2026-12-05T23:00",
  },
};
form.addEventListener("submit", (e) => {
  e.preventDefault();
  void update();
});
form.addEventListener("change", () => void update());
document
  .querySelector("#assumption-fields")!
  .addEventListener("input", () => void update());
document.querySelector("#reset")!.addEventListener("click", () => {
  values = initial();
  renderSettings();
  void update();
});
document
  .querySelectorAll<HTMLButtonElement>("[data-scenario]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      form.reset();
      document
        .querySelectorAll("[data-scenario]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      for (const [id, value] of Object.entries(
        scenarios[button.dataset.scenario!]!,
      ))
        field(id).value = value;
      void update();
    }),
  );
const theme = document.querySelector<HTMLButtonElement>("#theme")!;
function themeLabel() {
  const dark =
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme &&
      matchMedia("(prefers-color-scheme:dark)").matches);
  theme.textContent = dark ? "Light mode" : "Dark mode";
  theme.setAttribute(
    "aria-label",
    dark ? "Switch to light mode" : "Switch to dark mode",
  );
}
theme.addEventListener("click", () => {
  document.documentElement.dataset.theme =
    theme.textContent === "Dark mode" ? "dark" : "light";
  try {
    localStorage.setItem(
      "payroute-theme",
      document.documentElement.dataset.theme,
    );
  } catch {
    /* Theme works without storage. */
  }
  themeLabel();
});
matchMedia("(prefers-color-scheme:dark)").addEventListener(
  "change",
  themeLabel,
);
themeLabel();
document.addEventListener("click", (e) => {
  if (!(e.target as Element).closest(".source-wrap"))
    document.querySelectorAll(".source-wrap.open").forEach((x) => {
      x.classList.remove("open");
      x.querySelector("button")?.setAttribute("aria-expanded", "false");
    });
});
for (const id of ["amount", "send", "deadline", "max-fee"]) {
  const label = document.querySelector(`label[for="${id}"]`);
  if (label)
    attachSource(
      label as HTMLLabelElement,
      assumption(
        "Visitor-selected test input. Scenario defaults are illustrative and can be changed.",
      ),
    );
}
renderSettings();
renderSources();
void update();
void liveData();
