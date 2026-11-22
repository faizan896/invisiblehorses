import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import {
  flaggedCharges,
  reconcile,
  reportCsv,
} from "../src/review/reconcile.js";

const billHead = "request_id,amount,unit\n";
const jobHead = "request_id,customer_id,job_id,result\n";
const example = (name: string) =>
  readFileSync(
    new URL("../console/review/" + name + ".csv", import.meta.url),
    "utf8",
  );

describe("supplier spend review", () => {
  it("reproduces the downloadable sample without treating missing billing as zero", () => {
    const rows = reconcile(example("billing"), example("jobs"));
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.finding)).toEqual([
      "matched",
      "failed",
      "unattributed",
      "pending",
      "matched",
      "unbilled",
    ]);
    expect(flaggedCharges(rows)).toEqual(["$11.20", "42 credits"]);
    const report = parse(
      reportCsv(
        rows.filter((row) => row.finding === "unbilled"),
        "Sample",
      ),
      { columns: true },
    );
    expect(report).toMatchObject([
      {
        request_id: "req_8046",
        source: "Sample",
        amount: "",
        unit: "",
        result: "delivered",
      },
    ]);
  });

  it("reads BOMs, CRLF, reordered columns and quoted identifiers; neutralizes spreadsheet formulas on export", () => {
    const rows = reconcile(
      '\uFEFFunit,amount,request_id\r\nUSD,0.29,"a,""b"""\r\n',
      jobHead + '"a,""b""",=cmd,job,failed',
    );
    expect(rows[0]?.bill?.minor).toBe(29);
    const report = parse(reportCsv(rows, "Imported"), { columns: true });
    expect(report).toMatchObject([
      {
        request_id: 'a,"b"',
        customer_id: "'=cmd",
        source: "Imported",
        amount: "0.29",
        finding: "Billed · failed result",
      },
    ]);
  });

  it("keeps request IDs case-sensitive and compares one-sided files", () => {
    expect(
      reconcile(billHead + "a,5,USD", jobHead + "A,c,j,delivered").map(
        (row) => row.finding,
      ),
    ).toEqual(["unattributed", "unbilled"]);
    expect(reconcile(billHead, jobHead + "a,c,j,pending")[0]?.finding).toBe(
      "unbilled",
    );
    expect(reconcile(billHead + "a,0,USD", jobHead)[0]?.finding).toBe(
      "unattributed",
    );
    expect(
      reconcile(billHead + "a,0,credits", jobHead + "a,c,j,failed")[0]?.finding,
    ).toBe("matched");
    expect(() => reconcile(billHead, jobHead)).toThrow(/only headers/);
  });

  it.each(["1.234,USD", "-1,USD", "1e2,USD", "1.0,credits", "2,EUR"])(
    "rejects unsupported charge %s",
    (charge) => {
      expect(() => reconcile(billHead + "a," + charge, jobHead)).toThrow(
        /Billing row 2/,
      );
    },
  );

  it("rejects duplicate IDs on either side, unknown results and ambiguous schemas", () => {
    expect(() => reconcile(billHead + "a,1,USD\na,2,USD", jobHead)).toThrow(
      /repeats a request_id/,
    );
    expect(() =>
      reconcile(billHead, jobHead + "a,c,j,failed\na,c,j,delivered"),
    ).toThrow(/repeats a request_id/);
    expect(() => reconcile(billHead, jobHead + "a,c,j,done")).toThrow(
      /Job row 2/,
    );
    expect(() => reconcile("request_id,amount,amount,unit", jobHead)).toThrow(
      /repeats the amount/,
    );
    expect(() => reconcile("request_id,amount", jobHead)).toThrow(
      /missing the unit/,
    );
    expect(() => reconcile(billHead + "a,5", jobHead)).toThrow(/invalid CSV/);
  });

  it("enforces input limits and supports a full billing file without rounding totals", () => {
    const bills = Array.from(
      { length: 10000 },
      (_, i) => i + ",999999999.99,USD",
    ).join("\n");
    expect(flaggedCharges(reconcile(billHead + bills, jobHead))).toEqual([
      "$9,999,999,999,900.00",
    ]);
    expect(() =>
      reconcile(billHead + bills + "\nextra,1,USD", jobHead),
    ).toThrow(/10,000 rows/);
    expect(() => reconcile("x".repeat(2 * 1024 * 1024 + 1), jobHead)).toThrow(
      /2 MiB/,
    );
  });
});
