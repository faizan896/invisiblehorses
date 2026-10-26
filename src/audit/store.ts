import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { StoreCore } from './store-core.js';
export type { PaymentStatus, PaymentRow, ApprovalRow } from './store-core.js';

/** Node filesystem adapter; the payment/audit logic is shared with the hosted SQLite actor. */
export class Store extends StoreCore {
  declare readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    super(new Database(path));
    this.db.pragma('synchronous = FULL');
  }
}
