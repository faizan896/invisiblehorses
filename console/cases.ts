import "./cases.css";
import type {
  CasesSnapshot,
  CaseOperation,
  CaseItem,
  CaseEvent,
} from "../src/cases/model.js";
import { createCasesTransport } from "./cases-storage.js";

type Filters = {
  query: string;
  provider: string;
  source: string;
  kind: string;
  includeClear: boolean;
  group: boolean;
};
const savedFilters = new Map<string, Filters>();
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const title = (value: string) =>
  value
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
const providerName = (provider: string) =>
  provider === "stripe"
    ? "Stripe"
    : provider === "firecrawl"
      ? "Firecrawl"
      : "Custom provider";
const sourceName = (source: string) =>
  source === "demo" ? "Demo data" : "Imported, unverified";
const chargeNames: Record<string, string> = {
  unknown: "Unknown",
  reserved: "Reserved",
  reported_charged: "Charge reported",
  reported_not_charged: "No charge reported",
  refund_requested: "Refund requested",
  partially_refunded: "Partial refund reported",
  reported_refunded: "Refund reported",
};
const deliveryNames: Record<string, string> = {
  unknown: "Unknown",
  pending: "Pending",
  reported_delivered: "Delivery reported",
  reported_failed: "Failure reported",
};
const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Unknown time"
    : new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(parsed);
};
const amount = (value: number | null | undefined, unit: string) =>
  value == null
    ? "Unknown"
    : unit === "usd_cent"
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(value / 100)
      : new Intl.NumberFormat().format(value) + " credits";

const examples: Record<string, unknown> = {
  normalized: {
    format: "normalized",
    events: [
      {
        event_id: "example_charge_1",
        operation_id: "example_operation_1",
        job_id: "research_job_1",
        customer_id: "customer_1",
        provider: "custom",
        provider_ref: "supplier_request_1",
        unit: "usd_cent",
        kind: "charge_reported",
        amount_minor: 1250,
        occurred_at: "2026-11-04T10:00:00Z",
      },
      {
        event_id: "example_result_1",
        operation_id: "example_operation_1",
        job_id: "research_job_1",
        customer_id: "customer_1",
        provider: "custom",
        provider_ref: "supplier_request_1",
        unit: "usd_cent",
        kind: "result_failed",
        occurred_at: "2026-11-04T10:01:00Z",
      },
    ],
  },
  stripe: {
    format: "stripe",
    records: [
      {
        context: {
          job_id: "research_job_1",
          customer_id: "customer_1",
          operation_id: "stripe_operation_1",
        },
        response: {
          id: "evt_example_capture",
          type: "charge.captured",
          created: 1793786400,
          data: {
            object: {
              id: "ch_example",
              currency: "usd",
              paid: true,
              captured: true,
              amount_captured: 1250,
              amount_refunded: 0,
              refunded: false,
            },
          },
        },
      },
    ],
  },
  firecrawl: {
    format: "firecrawl",
    records: [
      {
        context: {
          job_id: "research_job_1",
          customer_id: "customer_1",
          operation_id: "crawl_operation_1",
        },
        observed_at: "2026-11-04T10:00:00Z",
        response: {
          id: "crawl_example",
          status: "completed",
          creditsUsed: 3,
          data: [{}],
        },
      },
    ],
  },
};

function modal(label: string, content: string, trigger?: HTMLElement) {
  document
    .querySelector<HTMLDialogElement>("dialog[data-cases-dialog]")
    ?.close();
  const dialog = document.createElement("dialog");
  dialog.dataset.casesDialog = "";
  dialog.className = "cases-dialog";
  dialog.setAttribute("aria-label", label);
  dialog.innerHTML =
    "<header><h2>" +
    esc(label) +
    '</h2><button type="button" data-cases-close autofocus>Close</button></header>' +
    content;
  document.body.append(dialog);
  dialog
    .querySelector("[data-cases-close]")!
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (trigger?.isConnected) trigger.focus();
  });
  dialog.showModal();
  return dialog;
}

window.addEventListener("hashchange", () => {
  if (location.hash !== "#cases")
    document
      .querySelector<HTMLDialogElement>("dialog[data-cases-dialog]")
      ?.close();
});

export function mountCases(
  container: Element,
  options: { workspaceId: string },
) {
  const transport = createCasesTransport(options.workspaceId);
  const filters = savedFilters.get(options.workspaceId) ?? {
    query: "",
    provider: "all",
    source: "all",
    kind: "all",
    includeClear: false,
    group: true,
  };
  savedFilters.set(options.workspaceId, filters);
  let snapshot: CasesSnapshot | null = null;
  let message = "";
  let busy = false;
  const lifecycle = new MutationObserver(() => {
    if (!container.isConnected) {
      document
        .querySelector<HTMLDialogElement>("dialog[data-cases-dialog]")
        ?.close();
      lifecycle.disconnect();
    }
  });
  lifecycle.observe(document.body, { childList: true, subtree: true });

  function alive() {
    return container.isConnected && location.hash === "#cases";
  }
  function sourceBadge(source: string) {
    return '<span class="cases-source">' + esc(sourceName(source)) + "</span>";
  }
  function shell() {
    container.innerHTML =
      '<div id="cases-app"><div class="heading"><div><h1>Cases</h1><p class="muted">Review charges and delivered results by customer job.</p></div><span class="cases-mode">Review only</span></div><div id="cases-storage-note"></div><p class="cases-explanation">These records come from demo data or your imported files. They are not a live provider feed or independently verified payment evidence. Cases do not initiate charges or refunds.</p><div class="cases-actions"><button type="button" data-case-import class="primary">Import records</button><button type="button" data-case-demo>Load sample cases</button><button type="button" data-case-export>Export records</button></div><p id="cases-message" class="cases-message" role="status" aria-live="polite"></p><div id="cases-body" aria-live="polite"><p class="muted">Loading saved records…</p></div></div>';
    container
      .querySelector<HTMLButtonElement>("[data-case-import]")!
      .addEventListener("click", (event) =>
        importDialog(event.currentTarget as HTMLElement),
      );
    container
      .querySelector<HTMLButtonElement>("[data-case-demo]")!
      .addEventListener(
        "click",
        (event) => void loadDemo(event.currentTarget as HTMLButtonElement),
      );
    container
      .querySelector<HTMLButtonElement>("[data-case-export]")!
      .addEventListener(
        "click",
        (event) => void exportRecords(event.currentTarget as HTMLButtonElement),
      );
  }

  function storageNote() {
    const note = container.querySelector("#cases-storage-note");
    if (!note) return;
    note.innerHTML =
      transport.storage === "browser"
        ? '<div class="cases-storage cases-storage-local"><strong>Saved in this browser.</strong> Records are not shared across devices. Export your records before clearing browser data.</div>'
        : '<div class="cases-storage"><strong>Saved in your workspace.</strong> Imported records remain unverified.</div>';
  }

  async function load() {
    try {
      snapshot = await transport.list();
      if (!alive()) return;
      storageNote();
      render();
    } catch (error) {
      if (!alive()) return;
      container.querySelector("#cases-body")!.innerHTML =
        '<div class="cases-empty" role="alert"><h2>Records could not be loaded</h2><p>' +
        esc(error instanceof Error ? error.message : "Try again.") +
        '</p><button type="button" data-cases-retry>Try again</button></div>';
      container
        .querySelector("[data-cases-retry]")!
        .addEventListener("click", () => void load());
    }
  }

  function render() {
    if (!snapshot || !alive()) return;
    const counts = snapshot.summary;
    const demo =
      container.querySelector<HTMLButtonElement>("[data-case-demo]")!;
    demo.disabled =
      busy ||
      snapshot.operations.some((operation) => operation.source === "demo");
    demo.textContent = snapshot.operations.some(
      (operation) => operation.source === "demo",
    )
      ? "Sample cases loaded"
      : "Load sample cases";
    container.querySelector("#cases-message")!.textContent = message;
    const body = container.querySelector("#cases-body")!;
    if (!snapshot.operations.length) {
      body.innerHTML =
        '<div class="cases-empty"><p class="kicker">No records yet</p><h2>Start with a customer job.</h2><p>Import supported Stripe charge events, Firecrawl job statuses, or normalized events. Each operation needs a customer ID and job ID so its charge and result can be reviewed together.</p><p class="small">No provider accounts are connected. Load sample cases to explore a missing result, an unknown charge, a pending refund and an unresolved reservation.</p><button type="button" data-cases-empty-demo>Explore sample cases</button></div>';
      body
        .querySelector<HTMLButtonElement>("[data-cases-empty-demo]")!
        .addEventListener(
          "click",
          (event) => void loadDemo(event.currentTarget as HTMLButtonElement),
        );
      return;
    }
    const kinds = [...new Set(snapshot.cases.map((item) => item.kind))].sort();
    if (
      filters.kind !== "all" &&
      !kinds.includes(filters.kind as (typeof kinds)[number])
    )
      filters.kind = "all";
    body.innerHTML =
      '<dl class="cases-summary"><div><dt>Needs review</dt><dd>' +
      counts.open_cases +
      "</dd></div><div><dt>Customer jobs</dt><dd>" +
      counts.jobs +
      "</dd></div><div><dt>Operations recorded</dt><dd>" +
      counts.operations +
      "</dd></div><div><dt>Imported cases</dt><dd>" +
      counts.imported_cases +
      '</dd></div></dl><form class="cases-filters" role="search" aria-label="Filter cases"><div class="cases-search"><label for="cases-search">Find a customer, job or request</label><input id="cases-search" type="search" value="' +
      esc(filters.query) +
      '" placeholder="Customer, job or provider reference" autocomplete="off"></div><div><label for="cases-provider">Provider</label><select id="cases-provider"><option value="all">All providers</option>' +
      ["stripe", "firecrawl", "custom"]
        .map(
          (provider) =>
            '<option value="' +
            provider +
            '" ' +
            (filters.provider === provider ? "selected" : "") +
            ">" +
            providerName(provider) +
            "</option>",
        )
        .join("") +
      '</select></div><div><label for="cases-kind">Case</label><select id="cases-kind"><option value="all">All reasons</option>' +
      kinds
        .map(
          (kind) =>
            '<option value="' +
            esc(kind) +
            '" ' +
            (filters.kind === kind ? "selected" : "") +
            ">" +
            esc(title(kind)) +
            "</option>",
        )
        .join("") +
      '</select></div><div><label for="cases-source">Evidence</label><select id="cases-source"><option value="all">All records</option><option value="demo" ' +
      (filters.source === "demo" ? "selected" : "") +
      '>Demo data</option><option value="imported_unverified" ' +
      (filters.source === "imported_unverified" ? "selected" : "") +
      '>Imported, unverified</option></select></div></form><div class="cases-list-options"><label class="check"><input id="cases-clear" type="checkbox" ' +
      (filters.includeClear ? "checked" : "") +
      '>Include records without open cases</label><label class="check"><input id="cases-group" type="checkbox" ' +
      (filters.group ? "checked" : "") +
      '>Group by customer job</label><span id="cases-result-count" class="small"></span></div><div id="cases-results"></div>';
    body
      .querySelector("form")!
      .addEventListener("submit", (event) => event.preventDefault());
    body
      .querySelector<HTMLInputElement>("#cases-search")!
      .addEventListener("input", (event) => {
        filters.query = (event.target as HTMLInputElement).value;
        renderRows();
      });
    for (const name of ["provider", "kind", "source"] as const)
      body
        .querySelector<HTMLSelectElement>("#cases-" + name)!
        .addEventListener("change", (event) => {
          filters[name] = (event.target as HTMLSelectElement).value;
          renderRows();
        });
    body
      .querySelector<HTMLInputElement>("#cases-clear")!
      .addEventListener("change", (event) => {
        filters.includeClear = (event.target as HTMLInputElement).checked;
        renderRows();
      });
    body
      .querySelector<HTMLInputElement>("#cases-group")!
      .addEventListener("change", (event) => {
        filters.group = (event.target as HTMLInputElement).checked;
        renderRows();
      });
    renderRows();
  }

  function renderRows() {
    if (!snapshot || !alive()) return;
    const openCases = new Map(
      snapshot.cases.map((item) => [item.operation_id, item]),
    );
    const query = filters.query.trim().toLowerCase();
    const operations = snapshot.operations.filter((operation) => {
      const item = openCases.get(operation.operation_id);
      if (!item && !filters.includeClear) return false;
      if (filters.provider !== "all" && operation.provider !== filters.provider)
        return false;
      if (filters.source !== "all" && operation.source !== filters.source)
        return false;
      if (filters.kind !== "all" && item?.kind !== filters.kind) return false;
      return (
        !query ||
        [
          operation.customer_id,
          operation.job_id,
          operation.operation_id,
          operation.provider_ref,
          item?.title ?? "",
        ].some((value) => value.toLowerCase().includes(query))
      );
    });
    const count = container.querySelector("#cases-result-count");
    if (count) count.textContent = operations.length + " shown";
    const results = container.querySelector("#cases-results")!;
    if (!operations.length) {
      results.innerHTML =
        '<div class="cases-empty"><h2>No matching records</h2><p>Change the filters or include records without open cases.</p><button type="button" data-case-clear-filters>Reset filters</button></div>';
      results
        .querySelector("[data-case-clear-filters]")!
        .addEventListener("click", () => {
          Object.assign(filters, {
            query: "",
            provider: "all",
            source: "all",
            kind: "all",
            includeClear: true,
          });
          render();
        });
      return;
    }
    const groups = new Map<string, CaseOperation[]>();
    for (const operation of operations) {
      const key = filters.group
        ? operation.customer_id + "\u0000" + operation.job_id
        : "";
      groups.set(key, [...(groups.get(key) ?? []), operation]);
    }
    results.innerHTML = [...groups.values()]
      .map((group) => {
        const first = group[0]!;
        return (
          '<section class="cases-group">' +
          (filters.group
            ? '<div class="cases-group-title"><div><p class="small">' +
              esc(first.customer_id) +
              "</p><h2>" +
              esc(first.job_id) +
              '</h2></div><span class="small">' +
              group.length +
              " operation" +
              (group.length === 1 ? "" : "s") +
              "</span></div>"
            : "") +
          '<ol class="cases-list">' +
          group
            .map((operation) =>
              row(operation, openCases.get(operation.operation_id)),
            )
            .join("") +
          "</ol></section>"
        );
      })
      .join("");
    results
      .querySelectorAll<HTMLButtonElement>("[data-case-open]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          const operation = snapshot!.operations.find(
            (item) => item.operation_id === button.dataset.caseOpen,
          );
          if (operation)
            detail(operation, openCases.get(operation.operation_id), button);
        }),
      );
  }

  function row(operation: CaseOperation, item?: CaseItem) {
    return (
      '<li class="cases-row"><div class="cases-row-main"><div class="cases-row-meta">' +
      sourceBadge(operation.source) +
      '<span class="small">' +
      esc(providerName(operation.provider)) +
      "</span></div><h3>" +
      esc(item?.title ?? "No open case") +
      '</h3><p class="cases-reason">' +
      esc(
        item?.reason ??
          "The saved charge and delivery records do not currently raise a case.",
      ) +
      '</p><p class="cases-reference">' +
      esc(operation.operation_id) +
      " · " +
      esc(operation.provider_ref) +
      '</p></div><dl class="cases-row-states"><div><dt>Charge</dt><dd>' +
      esc(
        chargeNames[operation.charge_state] ?? title(operation.charge_state),
      ) +
      "</dd>" +
      (operation.charge_minor != null
        ? '<dd class="small">' +
          esc(amount(operation.charge_minor, operation.unit)) +
          "</dd>"
        : "") +
      "</div><div><dt>Result</dt><dd>" +
      esc(
        deliveryNames[operation.delivery_state] ??
          title(operation.delivery_state),
      ) +
      '</dd></div></dl><button type="button" data-case-open="' +
      esc(operation.operation_id) +
      '" aria-label="Review ' +
      esc(operation.operation_id) +
      '">Review →</button></li>'
    );
  }

  function detail(
    operation: CaseOperation,
    item: CaseItem | undefined,
    trigger: HTMLElement,
  ) {
    const fields = [
      ["Customer", operation.customer_id],
      ["Job", operation.job_id],
      ["Operation", operation.operation_id],
      ["Provider", providerName(operation.provider)],
      ["Provider reference", operation.provider_ref],
      ["Charge state", chargeNames[operation.charge_state]],
      ["Result state", deliveryNames[operation.delivery_state]],
      ["Reported charge", amount(operation.charge_minor, operation.unit)],
      [
        "Recorded reservation",
        amount(operation.reservation_minor, operation.unit),
      ],
      [
        "Approved bound",
        operation.bound_minor == null
          ? "Not recorded"
          : amount(operation.bound_minor, operation.unit),
      ],
      [
        "Reported refund",
        operation.refunded_minor > 0
          ? amount(operation.refunded_minor, operation.unit)
          : "No refund amount recorded",
      ],
    ];
    modal(
      item?.title ?? "Operation record",
      '<div class="cases-detail-source">' +
        sourceBadge(operation.source) +
        '<span class="small">Latest reported event ' +
        esc(date(operation.updated_at)) +
        "</span></div><p>" +
        esc(
          item?.reason ??
            "No open case is currently derived from these saved facts.",
        ) +
        "</p>" +
        (item
          ? '<div class="cases-next"><h3>Next step</h3><p>' +
            esc(item.next_step) +
            "</p></div>"
          : "") +
        '<dl class="cases-detail-fields">' +
        fields
          .map(
            ([label, value]) =>
              "<div><dt>" +
              esc(label) +
              "</dt><dd>" +
              esc(value) +
              "</dd></div>",
          )
          .join("") +
        '</dl><h3>Evidence timeline</h3><p class="small muted">These are saved reports, not independently checked provider or bank records. A delivered result does not establish its quality.</p><ol class="cases-timeline">' +
        operation.events.map((event) => eventRow(event, operation)).join("") +
        '</ol><p class="small muted">This view does not charge, retry or refund a request. Recovery must follow the original provider’s supported process.</p>',
      trigger,
    );
  }

  function eventRow(event: CaseEvent, operation: CaseOperation) {
    return (
      "<li><div><strong>" +
      esc(title(event.kind)) +
      "</strong>" +
      (event.amount_minor != null
        ? "<span>" + esc(amount(event.amount_minor, operation.unit)) + "</span>"
        : "") +
      '</div><p class="small">' +
      "Reported " +
      esc(date(event.occurred_at)) +
      " · Recorded " +
      esc(date(event.received_at)) +
      "</p><code>" +
      esc(event.event_id) +
      "</code></li>"
    );
  }

  async function loadDemo(button: HTMLButtonElement) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = "Loading samples…";
    try {
      const result = await transport.loadDemo();
      Object.assign(filters, {
        query: "",
        provider: "all",
        source: "demo",
        kind: "all",
        includeClear: false,
      });
      message = result.added
        ? "Sample records added. Every sample is labelled Demo data."
        : "Sample records are already saved.";
      await load();
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "Sample records could not be loaded.";
      if (alive())
        container.querySelector("#cases-message")!.textContent = message;
    } finally {
      busy = false;
      if (alive() && snapshot) render();
    }
  }

  async function exportRecords(button: HTMLButtonElement) {
    button.disabled = true;
    try {
      const records = await transport.exportRecords();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(records, null, 2)], {
          type: "application/json",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "invisible-horses-case-records.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (alive())
        container.querySelector("#cases-message")!.textContent =
          error instanceof Error
            ? error.message
            : "Records could not be exported.";
    } finally {
      button.disabled = false;
    }
  }

  function importDialog(trigger: HTMLElement) {
    const dialog = modal(
      "Import provider records",
      '<p>Import a JSON file or paste records below. Up to 1 MiB per import. Imports are saved as unverified reports.</p><form id="cases-import-form"><div class="cases-import-format"><div><label for="cases-import-format">Format</label><select id="cases-import-format"><option value="normalized">Normalized events</option><option value="stripe">Stripe charge events</option><option value="firecrawl">Firecrawl job statuses</option></select></div><button type="button" data-cases-use-example>Use example JSON</button></div><label for="cases-import-file">Choose a JSON file</label><input id="cases-import-file" type="file" accept=".json,application/json"><label for="cases-import-json">Records</label><textarea id="cases-import-json" rows="12" spellcheck="false" placeholder="Paste a complete import object, including its format and events or records."></textarea><p class="small muted">The example values are invented. Stripe imports need job_id, customer_id and operation_id in metadata or a context wrapper. Supported event types: charge.succeeded, charge.captured, charge.failed and charge.refunded. Refund imports need an explicit provider status; a refund request alone is not a completed refund. Firecrawl imports require the same IDs in a context object. Raw response content and provider credentials are not needed.</p><p class="form-error" id="cases-import-error" role="alert"></p><button class="primary" type="submit">Import records</button></form>',
      trigger,
    );
    const select = dialog.querySelector<HTMLSelectElement>(
      "#cases-import-format",
    )!;
    const input =
      dialog.querySelector<HTMLTextAreaElement>("#cases-import-json")!;
    const error = dialog.querySelector<HTMLElement>("#cases-import-error")!;
    dialog
      .querySelector("[data-cases-use-example]")!
      .addEventListener("click", () => {
        input.value = JSON.stringify(examples[select.value], null, 2);
        error.textContent = "";
        input.focus();
      });
    dialog
      .querySelector<HTMLInputElement>("#cases-import-file")!
      .addEventListener("change", async (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) return;
        input.value = "";
        if (file.size > 1048576) {
          error.textContent = "Choose a JSON file smaller than 1 MiB.";
          return;
        }
        try {
          const text = await file.text();
          const parsed = JSON.parse(text) as { format?: string };
          if (parsed.format && parsed.format in examples)
            select.value = parsed.format;
          input.value = text;
          error.textContent = "";
        } catch {
          error.textContent = "This file is not valid JSON.";
        }
      });
    dialog
      .querySelector<HTMLFormElement>("form")!
      .addEventListener("submit", async (event) => {
        event.preventDefault();
        const submit = dialog.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        )!;
        submit.disabled = true;
        error.textContent = "";
        try {
          if (new TextEncoder().encode(input.value).byteLength > 1048576)
            throw new Error(
              "The import exceeds 1 MiB. Split it into smaller files.",
            );
          let parsed: unknown;
          try {
            parsed = JSON.parse(input.value);
          } catch {
            throw new Error("Enter valid JSON before importing.");
          }
          if (
            !parsed ||
            typeof parsed !== "object" ||
            !("format" in parsed) ||
            parsed.format !== select.value
          )
            throw new Error(
              "The JSON format must match the selected import format.",
            );
          const result = await transport.importRecords(parsed);
          message =
            result.added +
            " new event" +
            (result.added === 1 ? "" : "s") +
            " recorded. " +
            result.duplicates +
            " already recorded.";
          Object.assign(filters, {
            query: "",
            provider: "all",
            source: "imported_unverified",
            kind: "all",
            includeClear: result.open_cases === 0,
          });
          dialog.close();
          await load();
        } catch (failure) {
          error.textContent =
            failure instanceof Error
              ? failure.message
              : "Records could not be imported.";
          submit.disabled = false;
        }
      });
  }

  shell();
  void load();
}
