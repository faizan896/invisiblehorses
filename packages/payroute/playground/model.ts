import { defaultAdapters, type RouteQuote } from "../src/index.js";
import { RouteQuoteSchema } from "../src/rails/adapter.js";
import { minor, decimal } from "../src/intent/schema.js";

export const checked = "2026-10-28";
export const sources = {
  ach: {
    name: "Federal Reserve",
    url: "https://www.frbservices.org/resources/resource-centers/same-day-ach-resource-center/fedach-processing-schedule/",
    reason:
      "Same Day ACH operator submission deadlines: 10:30, 14:45 and 16:45 Eastern. These are not a customer bank cutoff or a promise of next-day delivery.",
  },
  holidays: {
    name: "Federal Reserve",
    url: "https://www.frbservices.org/about/holiday-schedules/",
    reason:
      "Federal Reserve holidays. Sunday holidays close the following Monday; Saturday holidays do not close the preceding Friday. Used for this US calendar only, not a Mexican bank calendar.",
  },
  fednow: {
    name: "Federal Reserve",
    url: "https://www.frbservices.org/resources/financial-services/fednow-service-resources/fednow-service-operating-hours/",
    reason:
      "FedNow operates 24 hours a day, including weekends and holidays. No FedNow adapter or customer price is configured here.",
  },
  rtp: {
    name: "The Clearing House",
    url: "https://www.theclearinghouse.org/payment-systems/rtp/institution",
    reason:
      "RTP operates 24/7. Participation and customer pricing depend on the bank. No RTP adapter is configured here.",
  },
  wise: {
    name: "Wise",
    url: "https://wise.com/us/pricing/send-money",
    reason:
      "Wise publishes use of the mid-market rate without a separate exchange-rate markup. Exact service fees require a corridor-specific quote. The generic bank model here is not Wise.",
  },
  base: {
    name: "Base",
    url: "https://docs.base.org/specifications/transactions/network-fees",
    reason:
      "Base fees include execution, L1 data and operator costs. A gas price alone is not a full transfer quote. Mainnet telemetry is not Sepolia test-token pricing.",
  },
};
export type Setting = {
  id: string;
  label: string;
  value: number;
  unit: string;
  reason: string;
  min?: number;
  max?: number;
  step?: number;
};
const setting = (
  id: string,
  label: string,
  value: number,
  unit: string,
  reason: string,
  max = 1000000,
): Setting => ({
  id,
  label,
  value,
  unit,
  reason,
  min: 0,
  max,
  step:
    unit === "%" || unit.includes("per USD")
      ? 0.0001
      : unit === "USD"
        ? 0.01
        : 1,
});
export const settings: Setting[] = [
  setting(
    "mxn",
    "MXN exchange rate",
    17,
    "MXN per USD",
    "Existing test rate. No executable provider quote is configured.",
  ),
  setting(
    "eur",
    "EUR exchange rate",
    0.92,
    "EUR per USD",
    "Existing test rate. No executable provider quote is configured.",
  ),
  setting(
    "achFixed",
    "ACH fixed fee",
    0.25,
    "USD",
    "Fictional bank fee. Network wholesale fees do not establish a customer price.",
  ),
  setting(
    "achRate",
    "ACH variable fee",
    0.1,
    "%",
    "Existing simulated bank fee, not a published customer tariff.",
    100,
  ),
  setting(
    "achCap",
    "ACH fee cap",
    5,
    "USD",
    "Existing simulated bank fee cap.",
  ),
  setting(
    "bankFixed",
    "Bank transfer fixed fee",
    0.5,
    "USD",
    "Generic cross-border bank model. No Wise quote is contacted.",
  ),
  setting(
    "bankRate",
    "Bank transfer variable fee",
    0.05,
    "%",
    "Generic model service fee. A real fee depends on corridor, funding and provider.",
    100,
  ),
  setting(
    "bankSpread",
    "Bank exchange-rate markup",
    0.05,
    "%",
    "Generic bank model, not Wise. Wise publishes no separate mid-market markup; that does not establish another bank’s price.",
    100,
  ),
  setting(
    "onramp",
    "USDC funding fee",
    0.05,
    "%",
    "No funding provider selected. Existing test funding assumption.",
    100,
  ),
  setting(
    "offFixed",
    "USDC bank payout fixed fee",
    1,
    "USD",
    "No payout provider selected; existing test assumption.",
  ),
  setting(
    "offRate",
    "USDC bank payout variable fee",
    0.08,
    "%",
    "No payout provider selected. A chain transfer is not a bank payout.",
    100,
  ),
  setting(
    "usdcSpread",
    "USDC exchange-rate markup",
    0.1,
    "%",
    "No conversion provider selected; existing test assumption.",
    100,
  ),
  setting(
    "gas",
    "USDC network allowance",
    0.02,
    "USD",
    "Existing USD planning allowance. Base Sepolia uses test ETH. Live mainnet gas is shown separately and is not a transfer quote.",
  ),
  setting(
    "variation",
    "Variable fee range",
    20,
    "%",
    "Illustrative uncertainty around external fees, not measured market bounds. The router uses the central estimate; the upper range is not a fee guarantee.",
    100,
  ),
  setting(
    "open",
    "Bank opening hour",
    9,
    "Eastern hour",
    "Provider working window assumption; FedNow and RTP do not share this restriction.",
    23,
  ),
  setting(
    "cutoff",
    "Customer bank cutoff",
    16,
    "Eastern hour",
    "Conservative provider assumption. FedACH’s final operator deadline is 16:45 Eastern.",
    23,
  ),
  setting(
    "bankExpected",
    "Bank expected wait",
    1,
    "banking days",
    "Existing model delivery estimate after processing, not an SLA.",
    30,
  ),
  setting(
    "bankLatest",
    "Bank latest wait",
    2,
    "banking days",
    "Existing model planning bound, not a guaranteed arrival.",
    30,
  ),
  setting(
    "payout",
    "USDC bank payout wait",
    2,
    "hours",
    "Existing payout estimate subject to assumed bank window. Does not model Mexican bank holidays.",
    720,
  ),
  setting(
    "reopen",
    "USDC payout after reopening",
    10,
    "Eastern hour",
    "Existing assumed payout time on the next US banking day.",
    23,
  ),
  setting(
    "confirm",
    "USDC confirmation wait",
    12,
    "seconds",
    "Existing modeled inclusion wait, not finality or bank delivery.",
    3600,
  ),
  setting(
    "ledgerTime",
    "Internal account wait",
    0,
    "seconds",
    "Atomic test ledger model. No external money movement.",
    3600,
  ),
  setting(
    "ledgerFee",
    "Internal account fee",
    0,
    "USD",
    "Free internal test transfer, not an external provider price.",
  ),
  ...[
    ["achCertainty", "ACH certainty", 90],
    ["bankCertainty", "Bank transfer certainty", 96],
    ["usdcBankCertainty", "USDC bank payout certainty", 94],
    ["usdcWalletCertainty", "USDC wallet certainty", 99],
    ["ledgerCertainty", "Internal account certainty", 100],
  ].map(([id, label, value]) =>
    setting(
      String(id),
      String(label),
      Number(value),
      "%",
      "Uncalibrated model score, not an observed success rate or probability.",
      100,
    ),
  ),
  setting(
    "liquidity",
    "Available test liquidity",
    1000000,
    "USD",
    "Fictional rail balance; no bank or wallet balance is read.",
  ),
  setting(
    "railLimit",
    "Rail amount limit",
    1000000,
    "USD",
    "Fictional provider limit, not a published network limit.",
  ),
  setting(
    "paymentLimit",
    "Owner payment limit",
    30000,
    "USD",
    "Demo owner policy, applied by the existing router.",
  ),
  setting(
    "dailyLimit",
    "Owner daily limit",
    50000,
    "USD",
    "Demo owner policy, applied by the existing router.",
  ),
  setting(
    "approval",
    "Owner approval threshold",
    100,
    "USD",
    "Demo owner policy. This page cannot approve or send a payment.",
  ),
  setting(
    "spent",
    "Owner already spent today",
    0,
    "USD",
    "Fictional account history.",
  ),
  setting(
    "expiryYear",
    "Owner policy expiration year",
    2030,
    "year, January 1 UTC",
    "Fictional demo owner policy expiry, not a real account policy.",
    2100,
  ),
  setting(
    "minimumCertainty",
    "Owner minimum certainty",
    0,
    "%",
    "Demo policy gate, applied to uncalibrated model scores.",
    100,
  ),
  setting(
    "validity",
    "Plan validity",
    300,
    "seconds",
    "Existing five-minute test quote lifetime; no provider guarantees this validity.",
    86400,
  ),
];
export type Values = Record<string, number>;
export const defaults = (): Values =>
  Object.fromEntries(settings.map((s) => [s.id, s.value]));
const eastern = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function parts(d: Date) {
  return Object.fromEntries(
    eastern
      .formatToParts(d)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
}
export function easternDay(d: Date) {
  const p = parts(d);
  return new Date(Date.UTC(p.year!, p.month! - 1, p.day!));
}
function key(d: Date) {
  return d.toISOString().slice(0, 10);
}
export function holiday(d: Date) {
  const year = d.getUTCFullYear();
  const fixed = [
    [1, 1],
    [6, 19],
    [7, 4],
    [11, 11],
    [12, 25],
  ].map(([m, day]) => {
    const x = new Date(Date.UTC(year, m! - 1, day));
    if (x.getUTCDay() === 0) x.setUTCDate(x.getUTCDate() + 1);
    return key(x);
  });
  const nth = (m: number, n: number) => {
    const x = new Date(Date.UTC(year, m - 1, 1));
    x.setUTCDate(1 + ((8 - x.getUTCDay()) % 7) + (n - 1) * 7);
    return key(x);
  };
  const memorial = new Date(Date.UTC(year, 4, 31));
  memorial.setUTCDate(31 - ((memorial.getUTCDay() + 6) % 7));
  const thanksgiving = new Date(Date.UTC(year, 10, 1));
  thanksgiving.setUTCDate(1 + ((11 - thanksgiving.getUTCDay()) % 7) + 21);
  return [
    ...fixed,
    nth(1, 3),
    nth(2, 3),
    key(memorial),
    nth(9, 1),
    nth(10, 2),
    key(thanksgiving),
  ].includes(key(d));
}
export function working(d: Date) {
  return ![0, 6].includes(d.getUTCDay()) && !holiday(d);
}
function addDays(d: Date, n: number) {
  const out = new Date(d);
  while (n > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    if (working(out)) n--;
  }
  return out;
}
export function atEastern(d: Date, hour: number) {
  const target = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    hour,
  );
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess));
    guess +=
      target - Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
  }
  return new Date(guess).toISOString();
}
export function bankTimes(now: string, v: Values) {
  const p = parts(new Date(now));
  let day = easternDay(new Date(now));
  const accepting = working(day) && p.hour! >= v.open! && p.hour! < v.cutoff!;
  if (!working(day) || p.hour! >= v.cutoff!) day = addDays(day, 1);
  return {
    accepting,
    expected: atEastern(addDays(day, v.bankExpected!), v.cutoff!),
    latest: atEastern(addDays(day, v.bankLatest!), v.cutoff!),
  };
}
export function payoutTime(now: string, v: Values) {
  const desired = new Date(Date.parse(now) + v.payout! * 3600000);
  const p = parts(desired);
  let day = easternDay(desired);
  if (working(day) && p.hour! >= v.open! && p.hour! < v.cutoff!)
    return desired.toISOString();
  if (!working(day) || p.hour! >= v.cutoff!) day = addDays(day, 1);
  return atEastern(day, v.reopen!);
}
export function playgroundAdapters(v: Values) {
  return defaultAdapters().map((adapter) => ({
    id: adapter.id,
    execute: adapter.execute.bind(adapter),
    status: adapter.status.bind(adapter),
    reverse: adapter.reverse.bind(adapter),
    async quote(c: Parameters<typeof adapter.quote>[0]) {
      const q = await adapter.quote(c);
      if (!q) return null;
      const rate =
        c.intent.destination_currency === "USD"
          ? 1
          : v[c.intent.destination_currency === "MXN" ? "mxn" : "eur"]!;
      const ceil = (n: bigint, d: bigint) => {
        const result = (n + d - 1n) / d;
        if (result > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error("Amount exceeds exact range");
        return Number(result);
      };
      const principal = ceil(
        BigInt(minor(c.intent.amount)) * 1000000n,
        BigInt(Math.round(rate * 1000000)),
      );
      const fee = (n: number) => minor(n.toFixed(2)),
        percent = (p: number) =>
          ceil(BigInt(principal) * BigInt(Math.round(p * 10000)), 1000000n);
      const bank = bankTimes(c.now, v),
        isFx = c.intent.destination_currency !== "USD";
      let expected = c.now,
        latest = c.now,
        certainty = v.ledgerCertainty! / 100,
        accepting = true;
      const fees: RouteQuote["fees_usd"] = [];
      const add = (
        kind: RouteQuote["fees_usd"][number]["kind"],
        cents: number,
      ) =>
        fees.push({
          kind,
          amount: decimal(cents),
          description: "Editable playground assumption",
        });
      if (q.rail === "ledger") {
        add("service", fee(v.ledgerFee!));
        expected = latest = new Date(
          Date.parse(c.now) + v.ledgerTime! * 1000,
        ).toISOString();
      }
      if (q.rail === "ach-mock") {
        add(
          "bank",
          Math.min(fee(v.achCap!), fee(v.achFixed!) + percent(v.achRate!)),
        );
        expected = bank.expected;
        latest = bank.latest;
        accepting = bank.accepting;
        certainty = v.achCertainty! / 100;
      }
      if (q.rail === "wise-quote") {
        add("service", fee(v.bankFixed!) + percent(v.bankRate!));
        add("fx_spread", isFx ? percent(v.bankSpread!) : 0);
        expected = bank.expected;
        latest = bank.latest;
        accepting = bank.accepting;
        certainty = v.bankCertainty! / 100;
      }
      if (q.rail === "usdc-base-sepolia") {
        add("onramp", percent(v.onramp!));
        add("network", fee(v.gas!));
        add("fx_spread", isFx ? percent(v.usdcSpread!) : 0);
        add(
          "offramp",
          q.destination_form === "bank"
            ? fee(v.offFixed!) + percent(v.offRate!)
            : 0,
        );
        const confirmed = new Date(
          Date.parse(c.now) + v.confirm! * 1000,
        ).toISOString();
        expected = latest =
          q.destination_form === "bank" ? payoutTime(confirmed, v) : confirmed;
        certainty =
          v[
            q.destination_form === "bank"
              ? "usdcBankCertainty"
              : "usdcWalletCertainty"
          ]! / 100;
      }
      const total = fees.reduce((n, f) => n + minor(f.amount), 0);
      return RouteQuoteSchema.parse({
        ...q,
        principal_usd: decimal(principal),
        fees_usd: fees,
        total_fee_usd: decimal(total),
        total_all_in_cost: {
          amount: decimal(principal + total),
          currency: "USD",
        },
        steps: fees.map((f) => ({
          kind:
            q.rail === "ledger"
              ? "internal"
              : f.kind === "fx_spread"
                ? "fx"
                : f.kind === "service"
                  ? "bank"
                  : f.kind,
          description: f.description,
          simulated: true,
          fee_usd: f.amount,
        })),
        expected_available_at: expected,
        latest_available_at: latest,
        certainty,
        constraints: {
          ...q.constraints,
          accepting_now: accepting,
          liquidity_usd: decimal(fee(v.liquidity!)),
          max_amount_usd: decimal(fee(v.railLimit!)),
        },
        expires_at: new Date(
          Date.parse(c.now) + v.validity! * 1000,
        ).toISOString(),
      });
    },
  }));
}
