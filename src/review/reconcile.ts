import { parse } from "csv-parse/browser/esm/sync";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 10_000;
export type Unit = "USD" | "credits";
type Bill = { request: string; minor: number; unit: Unit };
type Job = {
  request: string;
  customer: string;
  job: string;
  result: "delivered" | "failed" | "pending";
};
export const findings = {
  failed: [
    "Billed · failed result",
    "Inspect the failure and confirm the supplier’s billing terms.",
  ],
  unattributed: [
    "No job record",
    "Trace the request ID in application logs and check the export window.",
  ],
  pending: [
    "Billed · pending result",
    "Check the latest job status and when the result was due.",
  ],
  unbilled: [
    "No billing record",
    "Check the next billing export or whether this call was free.",
  ],
  matched: [
    "Matched",
    "Both records are present. No billing exception flagged.",
  ],
} as const;
export type Finding = keyof typeof findings;
export type ReviewRow = {
  request: string;
  bill?: Bill;
  job?: Job;
  finding: Finding;
};

function readRecords<T extends { request: string }>(
  csv: string,
  label: string,
  fields: string[],
  read: (values: Record<string, string>, row: number) => T,
): Map<string, T> {
  if (new TextEncoder().encode(csv).length > MAX_FILE_BYTES)
    throw new Error(label + " exceeds 2 MiB.");
  let rows: string[][];
  try {
    rows = parse(csv, { bom: true, skip_empty_lines: true, to: MAX_ROWS + 2 });
  } catch {
    throw new Error(
      label + " contains invalid CSV. Check quotes and column counts.",
    );
  }
  const headers = (rows.shift() ?? []).map((header) =>
    header.trim().toLowerCase(),
  );
  for (const field of fields) {
    if (!headers.includes(field))
      throw new Error(label + " is missing the " + field + " column.");
    if (headers.indexOf(field) !== headers.lastIndexOf(field))
      throw new Error(label + " repeats the " + field + " column.");
  }
  if (rows.length > MAX_ROWS) throw new Error(label + " exceeds 10,000 rows.");
  const records = new Map<string, T>();
  const columns = fields.map(
    (field) => [field, headers.indexOf(field)] as const,
  );
  for (const [i, row] of rows.entries()) {
    const values: Record<string, string> = {};
    for (const [field, column] of columns) {
      const value = row[column]!.trim();
      if (!value || value.length > 160 || /[\r\n\t]/.test(value))
        throw new Error(
          label +
            " row " +
            (i + 2) +
            " needs a single " +
            field +
            " value of up to 160 characters.",
        );
      values[field] = value;
    }
    const record = read(values, i + 2);
    if (records.has(record.request))
      throw new Error(
        label +
          " row " +
          (i + 2) +
          " repeats a request_id. Supply one final row per request.",
      );
    records.set(record.request, record);
  }
  return records;
}

function readBill(values: Record<string, string>, row: number): Bill {
  const { request_id, amount, unit } = values;
  if (unit !== "USD" && unit !== "credits")
    throw new Error("Billing row " + row + " needs USD or credits in unit.");
  const pattern = unit === "USD" ? /^\d{1,9}(\.\d{1,2})?$/ : /^\d{1,9}$/;
  if (!pattern.test(amount!))
    throw new Error(
      "Billing row " +
        row +
        " needs a nonnegative amount of up to nine digits, with up to two decimals for USD or whole units for credits.",
    );
  const [whole, fraction = ""] = amount!.split(".");
  const minor =
    unit === "USD"
      ? Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
      : Number(whole);
  return { request: request_id!, minor, unit };
}

function readJob(values: Record<string, string>, row: number): Job {
  const { request_id, customer_id, job_id, result } = values;
  if (result !== "delivered" && result !== "failed" && result !== "pending")
    throw new Error(
      "Job row " + row + " needs delivered, failed or pending in result.",
    );
  return { request: request_id!, customer: customer_id!, job: job_id!, result };
}

export function reconcile(billingCsv: string, jobsCsv: string): ReviewRow[] {
  const bills = readRecords(
    billingCsv,
    "Billing CSV",
    ["request_id", "amount", "unit"],
    readBill,
  );
  const jobs = readRecords(
    jobsCsv,
    "Job CSV",
    ["request_id", "customer_id", "job_id", "result"],
    readJob,
  );
  const requests = new Set([...bills.keys(), ...jobs.keys()]);
  if (!requests.size)
    throw new Error(
      "Both CSVs contain only headers. Include at least one record.",
    );
  return Array.from(requests, (request) => {
    const bill = bills.get(request);
    const job = jobs.get(request);
    let finding: Finding = "matched";
    if (!bill) finding = "unbilled";
    else if (!job) finding = "unattributed";
    else if (bill.minor > 0 && job.result !== "delivered") finding = job.result;
    return { request, bill, job, finding };
  });
}

export function formatCharge(minor: number, unit: Unit) {
  return unit === "USD"
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: unit,
      }).format(minor / 100)
    : minor.toLocaleString("en-US") + " credits";
}

export function flaggedCharges(rows: ReviewRow[]) {
  const totals = new Map<Unit, number>();
  for (const { finding, bill } of rows) {
    if (finding !== "matched" && bill)
      totals.set(bill.unit, (totals.get(bill.unit) ?? 0) + bill.minor);
  }
  return [...totals].map(([unit, minor]) => formatCharge(minor, unit));
}

export function reportCsv(rows: ReviewRow[], source: "Sample" | "Imported") {
  function cell(text: string) {
    const safe = /^[\s\uFEFF]*[=+@-]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  }
  const records = rows.map(({ request, bill, job, finding }) => [
    source,
    request,
    job?.customer ?? "",
    job?.job ?? "",
    job?.result ?? "",
    bill
      ? bill.unit === "USD"
        ? (bill.minor / 100).toFixed(2)
        : String(bill.minor)
      : "",
    bill?.unit ?? "",
    ...findings[finding],
  ]);
  return (
    [
      [
        "source",
        "request_id",
        "customer_id",
        "job_id",
        "result",
        "amount",
        "unit",
        "finding",
        "next_step",
      ],
      ...records,
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n") + "\r\n"
  );
}
