class CasesResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CasesResponseError";
  }
}
import { parseImport } from "../src/cases/adapters.js";
import { demoEvents } from "../src/cases/fixtures.js";
import {
  buildCasesSnapshot,
  eventPayload,
  mergeCaseEvents,
  type CaseEvent,
  type CaseEventInput,
  type CasesSnapshot,
  type ImportResult,
  type CaseSource,
} from "../src/cases/model.js";

const databaseName = "invisible-horses-cases-v1";
const storeName = "workspaces";
const maxBytes = 1048576;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB)
      return reject(
        new Error(
          "Browser storage is unavailable. Records could not be saved.",
        ),
      );
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(
        new Error(
          "Browser storage could not be opened. Check this browser's storage permissions.",
        ),
      );
    request.onblocked = () =>
      reject(new Error("Close other Invisible Horses tabs, then try again."));
  });
}

async function readEvents(workspaceId: string): Promise<CaseEvent[]> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).get(workspaceId);
      request.onsuccess = () =>
        resolve(
          Array.isArray(request.result) ? (request.result as CaseEvent[]) : [],
        );
      request.onerror = () =>
        reject(new Error("Saved case records could not be read."));
      tx.onabort = () =>
        reject(new Error("Saved case records could not be read."));
    });
  } finally {
    db.close();
  }
}

async function importIntoBrowser(
  workspaceId: string,
  input: CaseEventInput[],
  source: CaseSource,
): Promise<ImportResult> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = store.get(workspaceId);
      let result: ImportResult | undefined;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const existing: CaseEvent[] = Array.isArray(request.result)
            ? request.result
            : [];
          const merged = mergeCaseEvents(
            existing,
            input,
            source,
            new Date().toISOString(),
          );
          const snapshot = buildCasesSnapshot(merged.events);
          store.put(merged.events, workspaceId);
          result = {
            added: merged.added,
            duplicates: merged.duplicates,
            operations: snapshot.summary.operations,
            open_cases: snapshot.summary.open_cases,
          };
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      request.onerror = () => {
        failure = new Error(
          "The import could not be saved. Your existing records have not changed.",
        );
      };
      tx.oncomplete = () =>
        result
          ? resolve(result)
          : reject(new Error("The import did not finish."));
      tx.onabort = () =>
        reject(
          failure ??
            new Error(
              "The import could not be saved. Your existing records have not changed.",
            ),
        );
      tx.onerror = () => {
        failure ??= new Error(
          "Browser storage is full or unavailable. Your existing records have not changed.",
        );
      };
    });
  } finally {
    db.close();
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/console-api/cases" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new CasesResponseError(
      response.status || 503,
      "Cases could not be loaded. Try again.",
    );
  }
  if (!response.ok) {
    const message =
      typeof json === "object" &&
      json !== null &&
      "error" in json &&
      typeof json.error === "string"
        ? json.error
        : "Cases could not be loaded. Try again.";
    throw new CasesResponseError(response.status, message);
  }
  return json as T;
}

export function createCasesTransport(workspaceId: string) {
  let storage: "server" | "browser" = "server";
  let decided = false;
  const transport = {
    get storage() {
      return storage;
    },
    async list(): Promise<CasesSnapshot> {
      if (storage === "browser")
        return buildCasesSnapshot(await readEvents(workspaceId));
      try {
        const data = await request<CasesSnapshot>("");
        if (
          data.mode !== "read_only" ||
          !Array.isArray(data.operations) ||
          !Array.isArray(data.cases)
        )
          throw new Error(
            "Unexpected Cases response. Your records have not changed.",
          );
        if (!decided) {
          const local = await readEvents(workspaceId).catch(() => []);
          if (local.length) {
            storage = "browser";
            decided = true;
            return buildCasesSnapshot(local);
          }
        }
        decided = true;
        return data;
      } catch (error) {
        if (
          !decided &&
          error instanceof CasesResponseError &&
          error.status === 404
        ) {
          storage = "browser";
          decided = true;
          return buildCasesSnapshot(await readEvents(workspaceId));
        }
        throw error;
      }
    },
    async importRecords(input: unknown): Promise<ImportResult> {
      if (new TextEncoder().encode(JSON.stringify(input)).byteLength > maxBytes)
        throw new CasesResponseError(413, "Case import exceeds 1 MiB");
      if (!decided) await transport.list();
      const events = parseImport(input);
      if (storage === "server")
        return request<ImportResult>("/import", {
          format: "normalized",
          events,
        });
      return importIntoBrowser(workspaceId, events, "imported_unverified");
    },
    async loadDemo(): Promise<ImportResult> {
      if (!decided) await transport.list();
      if (storage === "server") return request<ImportResult>("/demo", {});
      return importIntoBrowser(workspaceId, demoEvents(), "demo");
    },
    async exportRecords(): Promise<{
      format: "normalized";
      events: CaseEventInput[];
    }> {
      if (!decided) await transport.list();
      if (storage === "server") return request("/export");
      const events = await readEvents(workspaceId);
      return {
        format: "normalized",
        events: events.map(
          (event) => JSON.parse(eventPayload(event)) as CaseEventInput,
        ),
      };
    },
  };
  return transport;
}
