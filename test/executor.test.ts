import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, intent, agentId, complete, approvalToken } from './support.js';

const fixtures: ReturnType<typeof fixture>[] = [];
const f = (path?: string) => { const v = fixture(path); fixtures.push(v); return v; };
afterEach(() => { for (const v of fixtures.splice(0)) if (v.store.db.open) v.store.close(); });

describe('Payment and approval workflow', () => {
  it('$5 allowed → $45 approved → $150 daily attempt denied → retry pays once', async () => {
    const v = f(); await v.service.initialize();
    const five = await v.service.request(intent(), agentId);
    expect(five.status).toBe('queued'); await complete(v);
    expect(v.service.get(five.id).status).toBe('completed');
    const fortyFive = await v.service.request(intent('45', 'invoice-2'), agentId);
    expect(fortyFive.status).toBe('pending_approval'); expect(v.notifier.notifications).toHaveLength(1);
    v.service.decide(approvalToken(v.notifier.notifications[0]!.approveUrl));
    await complete(v); expect(v.service.get(fortyFive.id).status).toBe('completed');
    const denied = await v.service.request(intent('100', 'invoice-3'), agentId);
    expect(denied.status).toBe('denied'); expect(denied.evaluation.reasons.join()).toMatch(/daily/i);
    const retry = await v.service.request(intent('5.00'), agentId); await complete(v);
    expect(retry.id).toBe(five.id); expect(v.executor.prepared).toBe(2); expect(v.executor.broadcasts.size).toBe(2);
    const events = JSON.stringify(v.store.events());
    for (const value of ['payment_requested','payment_approved','payment_completed','request_retried','owner:approval-token','dataset access']) expect(events).toContain(value);
    expect(events).not.toContain('token=');
  });
  it('rejects and consumes both buttons without ever transferring', async () => {
    const v = f(); v.policy.new_merchant_max = '100';
    const p = await v.service.request(intent('45'), agentId);
    const n = v.notifier.notifications[0]!;
    v.service.decide(approvalToken(n.rejectUrl));
    expect(() => v.service.decide(approvalToken(n.approveUrl))).toThrow(/already/);
    await complete(v); expect(v.service.get(p.id).status).toBe('rejected'); expect(v.executor.prepared).toBe(0);
    expect(v.service.limits().remaining_today).toBe('100.00');
  });
  it('expires at 15 minutes, releases reservation and refuses an old token', async () => {
    const v = f(); v.policy.new_merchant_max = '100';
    const p = await v.service.request(intent('45'), agentId);
    v.setNow('2026-10-25T12:15:00Z');
    expect(() => v.service.decide(approvalToken(v.notifier.notifications[0]!.approveUrl))).toThrow(/expired/);
    expect(v.service.limits().remaining_today).toBe('100.00');
    expect(v.service.get(p.id).status).toBe('expired');
  });
  it('reserves concurrent requests atomically before notifications or execution', async () => {
    const v = f(); v.policy.new_merchant_max = '100';
    const results = await Promise.all(Array.from({ length: 3 }, (_, n) => v.service.request(intent('45', `concurrent-${n}`), agentId)));
    expect(results.filter((p) => p.status === 'pending_approval')).toHaveLength(2);
    expect(results.filter((p) => p.status === 'denied')).toHaveLength(1);
    expect(v.service.limits().remaining_today).toBe('10.00');
  });
  it('retries pending requests without duplicating approvals or notifications', async () => {
    const v = f(); v.policy.new_merchant_max = '100';
    const [a, b] = await Promise.all([v.service.request(intent('45'), agentId), v.service.request(intent('45'), agentId)]);
    expect(a.id).toBe(b.id); expect(v.notifier.notifications).toHaveLength(1);
    await expect(v.service.request(intent('46'), agentId)).rejects.toThrow(/different intent/);
    expect(v.store.list()).toHaveLength(1);
  });
  it('does not trust a forged payer or previously used merchant ID with a new address', async () => {
    const v = f();
    await expect(v.service.request({ ...intent(), payer: 'another-agent' }, agentId)).rejects.toThrow(/Payer/);
    await v.service.request(intent(), agentId); await complete(v);
    const swapped = intent('45', 'other-wallet'); swapped.recipient.address = '0x0000000000000000000000000000000000000002';
    expect((await v.service.request(swapped, agentId)).status).toBe('denied');
  });
  it('rechecks the owner policy after approval and again before signing', async () => {
    const v = f(); v.policy.new_merchant_max = '100';
    const p = await v.service.request(intent('45'), agentId);
    v.policy.max_per_payment = '20';
    v.service.decide(approvalToken(v.notifier.notifications[0]!.approveUrl));
    expect(v.service.get(p.id).status).toBe('denied'); await complete(v); expect(v.executor.prepared).toBe(0);
    const v2 = f(); const queued = await v2.service.request(intent(), agentId);
    v2.policy.expires_at = '2026-10-25T12:00:00Z'; await complete(v2);
    expect(v2.service.get(queued.id).status).toBe('denied'); expect(v2.executor.prepared).toBe(0);
  });
  it('handles midnight UTC and rechecks old approvals against the new day', async () => {
    const v = f(); v.policy.new_merchant_max = '100';
    const old = await v.service.request(intent('45'), agentId);
    v.setNow('2026-10-25T12:14:00Z'); v.service.decide(approvalToken(v.notifier.notifications[0]!.approveUrl));
    await complete(v); expect(v.service.limits().spent_or_reserved_today).toBe('45.00');
    v.setNow('2026-10-26T00:00:00Z'); expect(v.service.limits().spent_or_reserved_today).toBe('0.00');
    expect(v.service.get(old.id).status).toBe('completed');
  });
  it('keeps missed pushes recoverable on the owner page', async () => {
    const v = f(); v.policy.new_merchant_max = '100'; v.notifier.fail = true;
    const p = await v.service.request(intent('45'), agentId);
    expect(p.status).toBe('pending_approval'); expect(v.service.pending()).toHaveLength(1);
    expect(JSON.stringify(v.store.events())).toContain('notification_failed');
  });
  it('does not carry a prior-day approval past the new day budget', async () => {
    const v = f(); v.policy.new_merchant_max = '100';
    v.setNow('2026-10-25T23:59:00Z');
    const old = await v.service.request(intent('45', 'yesterday'), agentId);
    const oldToken = approvalToken(v.notifier.notifications[0]!.approveUrl);
    v.setNow('2026-10-26T00:01:00Z');
    const today = await v.service.request(intent('100', 'today'), agentId);
    expect(today.status).toBe('pending_approval');
    v.service.decide(oldToken);
    expect(v.service.get(old.id).status).toBe('denied');
    expect(v.service.get(old.id).evaluation.reasons.join()).toMatch(/Daily/);
    await complete(v); expect(v.executor.prepared).toBe(0);
  });
  it('discards signed bytes if policy changes during asynchronous preparation', async () => {
    const v = f(); const original = v.executor.prepare.bind(v.executor);
    v.executor.prepare = async (input) => { const result = await original(input); v.policy.max_per_payment = '1'; return result; };
    const p = await v.service.request(intent(), agentId); await v.service.tick();
    expect(v.service.get(p.id).status).toBe('denied');
    expect(v.store.get(p.id)!.signed_transaction).toBeNull(); expect(v.executor.broadcasts.size).toBe(0);
  });
  it('deduplicates and claims execution across independent SQLite connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'railgate-concurrency-'));
    try {
      const path = join(dir, 'db.sqlite'); const a = f(path); const b = f(path);
      await a.service.initialize(); await b.service.initialize();
      const [one, two] = await Promise.all([a.service.request(intent(), agentId), b.service.request(intent(), agentId)]);
      expect(one.id).toBe(two.id);
      await Promise.all([a.service.tick(), b.service.tick()]);
      expect(a.executor.prepared + b.executor.prepared).toBe(1);
      await a.service.tick(); expect(a.service.get(one.id).status).toBe('completed');
      a.store.close(); b.store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('treats preparation failures as terminal for that idempotency key', async () => {
    const v = f(); v.executor.failPrepare = true;
    const p = await v.service.request(intent(), agentId); await complete(v);
    expect(v.service.get(p.id).status).toBe('failed'); v.executor.failPrepare = false;
    await v.service.request(intent(), agentId); await complete(v); expect(v.executor.prepared).toBe(0);
  });
  it('reconciles a timeout AFTER broadcast without a second payment', async () => {
    const v = f(); v.executor.ambiguousBroadcast = true;
    const p = await v.service.request(intent(), agentId); await v.service.tick();
    expect(v.service.get(p.id).status).toBe('submitted');
    await v.service.request(intent(), agentId); await complete(v);
    expect(v.service.get(p.id).status).toBe('completed'); expect(v.executor.prepared).toBe(1); expect(v.executor.broadcasts.size).toBe(1);
  });
  it('marks a reverted transaction failed and does not retry with a new nonce', async () => {
    const v = f(); v.executor.reverted = true;
    const p = await v.service.request(intent(), agentId); await complete(v);
    expect(v.service.get(p.id).status).toBe('failed');
    await v.service.request(intent(), agentId); await complete(v); expect(v.executor.prepared).toBe(1);
  });
  it('persists across restart and reuses exactly the signed bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'railgate-test-'));
    try {
      const path = join(dir, 'db.sqlite'); const a = f(path);
      const p = await a.service.request(intent(), agentId); await a.service.tick();
      const raw = a.store.get(p.id)!.signed_transaction; a.store.close();
      const b = f(path); await b.service.initialize();
      await b.service.request(intent(), agentId); await complete(b);
      expect(b.executor.prepared).toBe(0); expect(b.store.get(p.id)!.signed_transaction).toBe(raw);
      expect(b.service.get(p.id).status).toBe('completed'); b.store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('quarantines interrupted preparation and blocks further signing', async () => {
    const v = f(); const p = await v.service.request(intent(), agentId);
    v.store.db.prepare("UPDATE payments SET status = 'preparing' WHERE id = ?").run(p.id);
    await v.service.initialize(); await v.service.request(intent('5', 'next'), agentId); await complete(v);
    expect(v.service.get(p.id).status).toBe('uncertain'); expect(v.executor.prepared).toBe(0);
    expect(v.service.limits().spent_or_reserved_today).toBe('10.00');
  });
  it('enforces append-only audit at the database level', async () => {
    const v = f(); await v.service.request(intent(), agentId);
    expect(() => v.store.db.exec("UPDATE audit SET actor = 'agent'")).toThrow(/append-only/);
    expect(() => v.store.db.exec('DELETE FROM audit')).toThrow(/append-only/);
  });
});
