import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture, agentId } from './support.js';
const fixtures: ReturnType<typeof fixture>[] = [];
const f = () => { const v = fixture(); fixtures.push(v); return v; };
afterEach(() => { fixtures.splice(0).forEach((v) => v.store.close()); });
const input = (overrides = {}) => ({ idempotency_key: 'route-001', payer: agentId, recipient: 'dataco', amount: '1', destination_currency: 'USD', deadline: '2026-11-06T23:00:00Z', purpose: 'test plan', max_fee: '100', reversibility_requirement: 'none', recipient_preferences: {}, ...overrides });
describe('persisted route planning and API boundary', () => {
  it('records the full decision, alternatives and policy fingerprint without reserving money', async () => {
    const v = f(); const result = await v.routing.plan(input(), agentId);
    expect(result.decision).toBe('allow'); expect(result.selected?.rail).toBe('ledger');
    expect(result.alternatives).toHaveLength(4); expect(result.policy_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(v.routing.get(result.id, agentId)).toEqual(result);
    expect(() => v.routing.get(result.id, 'other-agent')).toThrow(/not found/);
    expect(v.store.list()).toHaveLength(0); expect(v.service.limits().spent_or_reserved_today).toBe('0.00');
    expect(JSON.stringify(v.store.events())).toContain(result.explanation);
  });
  it('does not call providers when the compliance or policy identity gate denies', async () => {
    const v = f(); const spy = vi.spyOn(v.quotes, 'quotes');
    const result = await v.routing.plan(input({ recipient: 'norte' }), agentId);
    expect(result.decision).toBe('deny'); expect(spy).not.toHaveBeenCalled();
    expect(result.explanation).toMatch(/allowlist/);
  });
  it('uses fresh time/history and owner policy after asynchronous quotes', async () => {
    const v = f(); const original = v.quotes.quotes.bind(v.quotes);
    vi.spyOn(v.quotes, 'quotes').mockImplementation(async (...args) => {
      v.setNow('2026-10-25T12:00:01Z'); const result = await original(...args);
      v.setNow('2026-10-25T12:00:02Z'); return result;
    });
    expect((await v.routing.plan(input(), agentId)).selected?.rail).toBe('ledger');
    vi.spyOn(v.quotes, 'quotes').mockImplementation(async (...args) => { const result = await original(...args); v.policy.expires_at = '2026-10-25T12:00:02Z'; return result; });
    expect((await v.routing.plan(input({ idempotency_key: 'edited-policy' }), agentId)).decision).toBe('deny');
  });
  it('authenticates POST/GET planning, validates input and never accepts a requested rail', async () => {
    const v = f(); const headers = { Authorization: `Bearer ${v.config.agentToken}`, 'Content-Type': 'application/json' };
    expect((await v.app.request('/api/routes', { method: 'POST', body: JSON.stringify(input()) })).status).toBe(401);
    expect((await v.app.request('/api/routes', { method: 'POST', headers, body: JSON.stringify(input({ rail: 'skip-policy' })) })).status).toBe(400);
    expect((await v.app.request('/api/routes', { method: 'POST', headers, body: JSON.stringify(input({ payer: 'forged' })) })).status).toBe(403);
    const response = await v.app.request('/api/routes', { method: 'POST', headers, body: JSON.stringify(input()) });
    expect(response.status).toBe(200); const result = await response.json() as { id: string };
    expect((await v.app.request(`/api/routes/${result.id}`, { headers })).status).toBe(200);
  });
});
