import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ApprovalTokens, type ApprovalPayload } from '../src/approval/tokens.js';
import { NtfyNotifier } from '../src/approval/notifier.js';
import { intent } from './support.js';

const tokens = new ApprovalTokens('synthetic-test-only-signing-material-123456');
const payload = (): ApprovalPayload => ({ v: 1, payment_id: randomUUID(), nonce: 'a'.repeat(32), action: 'approve', expires_at: '2026-10-25T12:15:00.000Z' });
describe('HMAC approval capabilities', () => {
  it('verifies a signed token only before its exact expiry', () => {
    const p = payload(); const token = tokens.sign(p);
    expect(tokens.verify(token, '2026-10-25T12:14:59.999Z')).toEqual(p);
    expect(() => tokens.verify(token, p.expires_at)).toThrow(/expired/);
  });
  it('rejects action/payload tampering, a foreign key and malformed signatures', () => {
    const p = payload(); const token = tokens.sign(p);
    const changed = Buffer.from(JSON.stringify({ ...p, action: 'reject' })).toString('base64url');
    expect(() => tokens.verify(`${changed}.${token.split('.')[1]}`, '2026-10-25T12:00:00Z')).toThrow(/signature/);
    const other = new ApprovalTokens('different-synthetic-test-signing-material');
    expect(() => other.verify(token, '2026-10-25T12:00:00Z')).toThrow(/signature/);
    for (const value of ['', 'abc', '..', `${token}.x`, `${token.split('.')[0]}.a`, 'a'.repeat(1501)]) expect(() => tokens.verify(value, '2026-10-25T12:00:00Z')).toThrow();
    expect(() => new ApprovalTokens('short')).toThrow();
  });
});
describe('ntfy documented JSON publish contract', () => {
  it('publishes explicit POST approve/reject actions without exposing topic to agents', async () => {
    let sent: RequestInit | undefined;
    const fetcher: typeof fetch = async (_url, options) => { sent = options; return new Response('{}', { status: 200 }); };
    const notifier = new NtfyNotifier('https://ntfy.sh', 'synthetic-test-only-topic', undefined, fetcher);
    await notifier.notify({ paymentId: randomUUID(), intent: intent('45'), approveUrl: 'https://owner.example.test/approve', rejectUrl: 'https://owner.example.test/reject', expiresAt: payload().expires_at });
    expect(sent?.method).toBe('POST');
    const body = JSON.parse(sent?.body as string);
    expect(body.message).toContain('research-agent-07 wants to pay $45 to DataCo');
    expect(body.message).toContain('TEST funds');
    expect(body.actions.map((a: { action: string; method: string; label: string }) => [a.action, a.method, a.label])).toEqual([['http', 'POST', 'Approve'], ['http', 'POST', 'Reject']]);
  });
  it('fails clearly without echoing secret URLs or an error response body', async () => {
    const notifier = new NtfyNotifier('https://ntfy.sh', 'synthetic-test-only-topic', undefined, async () => new Response('sensitive-topic-and-url', { status: 403 }));
    await expect(notifier.notify({ paymentId: randomUUID(), intent: intent(), approveUrl: '', rejectUrl: '', expiresAt: payload().expires_at })).rejects.toThrow('ntfy delivery failed');
  });
});
