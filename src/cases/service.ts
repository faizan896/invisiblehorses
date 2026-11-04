import type { SqlDatabase } from "../audit/store-core.js";
import { parseImport } from "./adapters.js";
import { demoEvents } from "./fixtures.js";
import {
  buildCasesSnapshot,
  eventPayload,
  mergeCaseEvents,
  type CaseEvent,
  type CaseEventInput,
  type CaseSource,
  type ImportResult,
} from "./model.js";
export class CasesService {
  constructor(
    readonly db: SqlDatabase,
    readonly workspaceId: string,
    readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS console_case_events (workspace_id TEXT NOT NULL,event_id TEXT NOT NULL,operation_id TEXT NOT NULL,payload TEXT NOT NULL,source TEXT NOT NULL,received_at TEXT NOT NULL,PRIMARY KEY(workspace_id,event_id)); CREATE INDEX IF NOT EXISTS console_case_operation ON console_case_events(workspace_id,operation_id);",
    );
  }
  private events(): CaseEvent[] {
    const rows = this.db
      .prepare(
        "SELECT payload,source,received_at FROM console_case_events WHERE workspace_id=? ORDER BY event_id",
      )
      .all(this.workspaceId) as {
      payload: string;
      source: CaseSource;
      received_at: string;
    }[];
    return rows.map((row) => ({
      ...(JSON.parse(row.payload) as CaseEventInput),
      source: row.source,
      received_at: row.received_at,
    }));
  }
  list() {
    return buildCasesSnapshot(this.events());
  }
  private save(events: CaseEventInput[], source: CaseSource): ImportResult {
    return this.db
      .transaction(() => {
        const existing = this.events(),
          previousIds = new Set(existing.map((event) => event.event_id));
        const result = mergeCaseEvents(
          existing,
          events,
          source,
          this.clock().toISOString(),
        );
        const insert = this.db.prepare(
          "INSERT INTO console_case_events(workspace_id,event_id,operation_id,payload,source,received_at) VALUES(?,?,?,?,?,?)",
        );
        for (const event of result.events)
          if (!previousIds.has(event.event_id))
            insert.run(
              this.workspaceId,
              event.event_id,
              event.operation_id,
              eventPayload(event),
              event.source,
              event.received_at,
            );
        const snapshot = buildCasesSnapshot(result.events);
        return {
          added: result.added,
          duplicates: result.duplicates,
          operations: snapshot.operations.length,
          open_cases: snapshot.cases.length,
        };
      })
      .immediate();
  }
  importRecords(input: unknown) {
    return this.save(parseImport(input), "imported_unverified");
  }
  loadDemo() {
    return this.save(demoEvents(), "demo");
  }
  exportRecords() {
    return {
      format: "normalized" as const,
      events: this.events().map(
        (event) => JSON.parse(eventPayload(event)) as CaseEventInput,
      ),
    };
  }
}
