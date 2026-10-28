import { describe, expect, it } from "vitest";
import {
  defaults,
  playgroundAdapters,
  holiday,
  bankTimes,
  atEastern,
} from "../playground/model.js";
import {
  defaultAdapters,
  Counterparties,
  PaymentIntentV2Schema,
  RouteQuoteSchema,
} from "../src/index.js";
import catalog from "../examples/counterparties.json" with { type: "json" };
const profiles = new Counterparties(catalog);
const context = (now = "2026-10-27T14:00:00Z", currency = "USD") => ({
  now,
  payer: profiles.get("research-agent-07"),
  recipient: profiles.get(currency === "MXN" ? "norte" : "dataco"),
  intent: PaymentIntentV2Schema.parse({
    idempotency_key: "check",
    payer: "research-agent-07",
    recipient: currency === "MXN" ? "norte" : "dataco",
    amount: currency === "MXN" ? "250000.00" : "10.00",
    destination_currency: currency,
    deadline: "2026-11-06T23:00:00Z",
    purpose: "test",
    reversibility_requirement: "none",
    max_fee: "100.00",
    recipient_preferences: { delivery: currency === "MXN" ? "bank" : "any" },
  }),
});
describe("playground inputs, without changing the routing engine", () => {
  it("preserves existing central prices and arrival windows at original defaults", async () => {
    for (const currency of ["USD", "MXN"])
      for (const now of ["2026-10-26T22:00:00Z", "2026-10-27T14:00:00Z"]) {
        const c = context(now, currency),
          original = defaultAdapters(),
          adapted = playgroundAdapters(defaults());
        for (let i = 0; i < original.length; i++) {
          const a = await original[i]!.quote(c),
            b = await adapted[i]!.quote(c);
          expect(Boolean(b)).toBe(Boolean(a));
          if (a && b) {
            expect(b.total_all_in_cost).toEqual(a.total_all_in_cost);
            expect(Date.parse(b.expected_available_at)).toBe(
              Date.parse(a.expected_available_at),
            );
            expect(Date.parse(b.latest_available_at)).toBe(
              Date.parse(a.latest_available_at),
            );
            expect(b.certainty).toBe(a.certainty);
            expect(b.constraints.accepting_now).toBe(a.constraints.accepting_now);
            expect(Number(b.constraints.liquidity_usd)).toBe(Number(a.constraints.liquidity_usd));
            expect(Number(b.constraints.max_amount_usd)).toBe(Number(a.constraints.max_amount_usd));
          }
        }
      }
  });
  it("reconciles fees and steps after rate and fee overrides, using exact cents", async () => {
    const values = { ...defaults(), mxn: 18.630737, onramp: 0.19, gas: 0.31 };
    const q = await playgroundAdapters(values)
      .find((a) => a.id === "usdc-base-sepolia")!
      .quote(context(undefined, "MXN"));
    expect(q).not.toBeNull();
    expect(() => RouteQuoteSchema.parse(q)).not.toThrow();
    expect(q!.principal_usd).toBe("13418.69");
    expect(q!.fees_usd.find((f) => f.kind === "network")!.amount).toBe("0.31");
  });
  it("uses the published Fed holiday treatment instead of closing Friday for Saturday holidays", () => {
    expect(holiday(new Date("2026-07-03T00:00:00Z"))).toBe(false);
    expect(holiday(new Date("2026-07-04T00:00:00Z"))).toBe(true);
    expect(holiday(new Date("2027-07-05T00:00:00Z"))).toBe(true);
    expect(holiday(new Date("2026-11-26T00:00:00Z"))).toBe(true);
  });
  it("honors edited bank hours and the daylight saving boundary", () => {
    expect(atEastern(new Date("2026-10-30"), 16)).toBe(
      "2026-10-30T20:00:00.000Z",
    );
    expect(atEastern(new Date("2026-11-02"), 16)).toBe(
      "2026-11-02T21:00:00.000Z",
    );
    expect(bankTimes("2026-10-27T20:00:00Z", defaults()).accepting).toBe(false);
    expect(
      bankTimes("2026-10-27T20:00:00Z", { ...defaults(), cutoff: 17 })
        .accepting,
    ).toBe(true);
  });
});
