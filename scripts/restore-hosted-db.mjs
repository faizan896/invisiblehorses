import { existsSync, mkdirSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';

export function verifyDatabase(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Database integrity check failed');
    db.prepare('SELECT id,payer,idempotency_key,fingerprint,status,transaction_hash FROM payments LIMIT 1').all();
    db.prepare('SELECT id,event FROM audit LIMIT 1').all();
  } finally { db.close(); }
}

/** Restoring can only create a missing database. It never replaces existing payment state. */
export function restoreHostedDatabase({ path, snapshot, sha256, allowBootstrap = false }) {
  if (!path) throw new Error('DATABASE_PATH is required');
  if (existsSync(path)) { verifyDatabase(path); return 'existing'; }
  if (!allowBootstrap) throw new Error('Persistent payment database is missing; automatic restoration of an old snapshot is forbidden');
  if (!snapshot || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Initial hosting requires the private database snapshot and its SHA256; refusing an empty payment history');
  if (snapshot.length > 96 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(snapshot)) throw new Error('Invalid or oversized database snapshot encoding');
  const data = gunzipSync(Buffer.from(snapshot, 'base64'), { maxOutputLength: 32 * 1024 * 1024 });
  if (!data.subarray(0,16).equals(Buffer.from('SQLite format 3\0')) || createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('Database snapshot verification failed');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.restore-${randomUUID()}`;
  try {
    writeFileSync(temp, data, { flag: 'wx', mode: 0o600 }); verifyDatabase(temp);
    // Hard-link creation is atomic and fails if another startup already created the destination.
    try { linkSync(temp, path); } catch (error) { if (error.code !== 'EEXIST') throw error; verifyDatabase(path); return 'existing'; }
    return 'restored';
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
