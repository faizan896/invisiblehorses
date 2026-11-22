/// <reference types="vite/client" />
import "../style.css";
import "./review.css";
import sampleBilling from "./billing.csv?raw";
import sampleJobs from "./jobs.csv?raw";
import billingTemplate from "./billing.csv?url";
import jobTemplate from "./jobs.csv?url";
import {
  findings,
  flaggedCharges,
  formatCharge,
  MAX_FILE_BYTES,
  reconcile,
  reportCsv,
  type ReviewRow,
} from "../../src/review/reconcile.js";

const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const dialog = byId<HTMLDialogElement>("import-dialog");
const form = byId<HTMLFormElement>("import-form");
const search = byId<HTMLInputElement>("search");
const scope = byId<HTMLSelectElement>("scope");
const sample = reconcile(sampleBilling, sampleJobs);
byId<HTMLAnchorElement>("billing-example").href = billingTemplate;
byId<HTMLAnchorElement>("job-example").href = jobTemplate;
const pageSize = 25;
let rows: ReviewRow[] = sample;
let filtered: ReviewRow[] = [];
let page = 0;

function node(tag: string, text: string, className?: string) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function record(row: ReviewRow) {
  const { bill, job, finding, request } = row;
  const li = document.createElement("li");
  const identity = document.createElement("div");
  identity.append(
    node("strong", request),
    node(
      "small",
      job ? job.customer + " / " + job.job : "Customer job unknown",
    ),
  );
  const reason = document.createElement("div");
  reason.append(
    node(
      "strong",
      findings[finding][0],
      finding === "matched" ? "clear" : "attention",
    ),
    node("small", findings[finding][1]),
  );
  const cost = document.createElement("div");
  cost.className = "record-amount";
  cost.append(
    node("strong", bill ? formatCharge(bill.minor, bill.unit) : "Unknown"),
    node("small", job ? "Result · " + job.result : "Result unknown"),
  );
  li.append(identity, reason, cost);
  return li;
}

function renderRecords() {
  const query = search.value.trim().toLowerCase();
  filtered = rows.filter(
    (row) =>
      (scope.value === "all" || row.finding !== "matched") &&
      [row.request, row.job?.customer, row.job?.job].some((value) =>
        value?.toLowerCase().includes(query),
      ),
  );
  const start = page * pageSize;
  const visible = filtered.slice(start, start + pageSize);
  byId("records").replaceChildren(...visible.map(record));
  byId("count").textContent = filtered.length
    ? "Showing " +
      (start + 1) +
      "–" +
      (start + visible.length) +
      " of " +
      filtered.length +
      " records"
    : "No records match this view. Try All requests or clear the search.";
  byId<HTMLButtonElement>("export").disabled = !filtered.length;
  byId("pagination").hidden = filtered.length <= pageSize;
  byId<HTMLButtonElement>("prev").disabled = page === 0;
  byId<HTMLButtonElement>("next").disabled =
    start + pageSize >= filtered.length;
}

function showReport(data: ReviewRow[]) {
  rows = data;
  const flags = rows.filter((row) => row.finding !== "matched").length;
  byId("report-title").textContent =
    rows === sample ? "Sample review" : "Your CSV review";
  byId("reset").hidden = rows === sample;
  byId("total").textContent = rows.length.toLocaleString();
  byId("flagged").textContent = flags.toLocaleString();
  byId("flagged").classList.toggle("attention", flags > 0);
  byId("charges").textContent =
    flaggedCharges(rows).join(" · ") || "None recorded";
  const billed = rows.filter((row) => row.bill);
  const linked = billed.filter((row) => row.job).length;
  byId("coverage").textContent = billed.length
    ? linked +
      " of " +
      billed.length +
      " billing records have a matching job record."
    : "The billing file contains no requests.";
  search.value = "";
  scope.value = flags ? "flagged" : "all";
  page = 0;
  renderRecords();
}

const theme = byId("theme");
function dark() {
  return document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
}
function themeLabel() {
  theme.textContent = dark() ? "Light mode" : "Dark mode";
}
themeLabel();
matchMedia("(prefers-color-scheme: dark)").addEventListener(
  "change",
  themeLabel,
);
theme.addEventListener("click", () => {
  const selected = dark() ? "light" : "dark";
  document.documentElement.dataset.theme = selected;
  try {
    localStorage.setItem("payroute-theme", selected);
  } catch {
    /* Theme still applies for this page. */
  }
  themeLabel();
});

for (const control of [search, scope])
  control.addEventListener("input", () => {
    page = 0;
    renderRecords();
  });
byId("prev").addEventListener("click", () => {
  page--;
  renderRecords();
});
byId("next").addEventListener("click", () => {
  page++;
  renderRecords();
});
byId("open-import").addEventListener("click", () => dialog.showModal());
byId("close-import").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  form.reset();
  byId("import-error").textContent = "";
});
byId("reset").addEventListener("click", () => {
  showReport(sample);
  byId("report-title").focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const billing = byId<HTMLInputElement>("billing-file").files?.[0];
  const jobs = byId<HTMLInputElement>("jobs-file").files?.[0];
  if (!billing || !jobs) return;
  const button = byId<HTMLButtonElement>("compare");
  button.disabled = true;
  try {
    if (billing.size > MAX_FILE_BYTES || jobs.size > MAX_FILE_BYTES)
      throw new Error("Each CSV must be 2 MiB or smaller.");
    const [billCsv, jobCsv] = await Promise.all([billing.text(), jobs.text()]);
    if (
      !dialog.open ||
      billing !== byId<HTMLInputElement>("billing-file").files?.[0] ||
      jobs !== byId<HTMLInputElement>("jobs-file").files?.[0]
    )
      return;
    showReport(reconcile(billCsv, jobCsv));
    dialog.close();
    byId("report-title").focus();
  } catch (error) {
    byId("import-error").textContent =
      error instanceof Error
        ? error.message
        : "The files could not be compared.";
  } finally {
    button.disabled = false;
  }
});

byId("export").addEventListener("click", () => {
  const source = rows === sample ? "Sample" : "Imported";
  const url = URL.createObjectURL(
    new Blob([reportCsv(filtered, source)], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "spend-review-" + source.toLowerCase() + ".csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

showReport(sample);
