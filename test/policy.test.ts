import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/policy/engine.js';
import { PolicySchema } from '../src/policy/schema.js';
import { PaymentIntentSchema } from '../src/intent/schema.js';

const now = '2026-10-25T12:00:00.000Z';
const policy = () => PolicySchema.parse({
  max_per_payment: 100, max_per_day: 100, new_merchant_max: 5,
  require_approval_above: 20, expires_at: '2030-01-01T00:00:00Z',
  allowed_merchants: [{ id: 'dataco', categories: ['data'] }, { id: 'compute' }],
});
const intent = (amount = '5.00') => PaymentIntentSchema.parse({
  idempotency_key: 'invoice-01', payer: 'research-agent-07',
  recipient: { id: 'dataco', name: 'DataCo', address: '0x0000000000000000000000000000000000000001', category: 'data' },
  amount, purpose: 'dataset access',
});
const history = (overrides = {}) => ({ now, spent_today: '0.00', paid_merchants: ['dataco:0x0000000000000000000000000000000000000001'], ...overrides });

describe('deterministic policy gates (tests written before implementation)', () => {
  it('allows the $5 example and exact approval threshold', () => {
    expect(evaluate(intent(), policy(), history()).decision).toBe('allow');
    expect(evaluate(intent('20'), policy(), history()).decision).toBe('allow');
  });
  it('requires approval strictly above $20', () => {
    expect(evaluate(intent('20.01'), policy(), history()).decision).toBe('needs_approval');
    expect(evaluate(intent('45'), policy(), history()).decision).toBe('needs_approval');
  });
  it('allows approval at the hard ceiling but never beyond it', () => {
    expect(evaluate(intent('100'), policy(), history()).decision).toBe('needs_approval');
    expect(evaluate(intent('100.01'), policy(), history()).decision).toBe('deny');
  });
  it('denies overspending including pending reservations, permits exact daily limit', () => {
    expect(evaluate(intent('45'), policy(), history({ spent_today: '55' })).decision).toBe('needs_approval');
    expect(evaluate(intent('45'), policy(), history({ spent_today: '55.01' })).decision).toBe('deny');
    expect(evaluate(intent('100'), policy(), history({ spent_today: '50' })).reasons.join(' ')).toMatch(/daily/i);
  });
  it('limits allowed merchants with no successful payment history', () => {
    expect(evaluate(intent('5'), policy(), history({ paid_merchants: [] })).decision).toBe('allow');
    expect(evaluate(intent('5.01'), policy(), history({ paid_merchants: [] })).decision).toBe('deny');
  });
  it('denies merchants outside the allowlist and unapproved categories', () => {
    const unknown = intent(); unknown.recipient.id = 'unknown';
    expect(evaluate(unknown, policy(), history()).decision).toBe('deny');
    const wrongCategory = intent(); wrongCategory.recipient.category = 'compute';
    expect(evaluate(wrongCategory, policy(), history()).decision).toBe('deny');
    const noCategory = intent(); delete noCategory.recipient.category;
    expect(evaluate(noCategory, policy(), history()).decision).toBe('deny');
  });
  it('expires at the exact instant specified and rejects an invalid clock', () => {
    const expired = policy(); expired.expires_at = now;
    expect(evaluate(intent(), expired, history()).decision).toBe('deny');
    expect(evaluate(intent(), policy(), history({ now: 'invalid' })).decision).toBe('deny');
  });
  it('hard denials take precedence over approval and accumulate clear reasons', () => {
    const p = policy(); p.expires_at = now;
    const result = evaluate(intent('150'), p, history());
    expect(result.decision).toBe('deny');
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });
  it('uses exact decimal arithmetic and does not mutate its inputs', () => {
    const p = policy(); p.max_per_day = '0.30'; p.require_approval_above = '0.30';
    const args = [intent('0.10'), p, history({ spent_today: '0.20' })] as const;
    const before = JSON.stringify(args);
    expect(evaluate(...args).decision).toBe('allow');
    expect(JSON.stringify(args)).toBe(before);
  });
  it('rejects malformed policies, duplicate merchants and invalid money', () => {
    expect(() => PolicySchema.parse({ ...policy(), max_per_day: -1 })).toThrow();
    expect(() => PolicySchema.parse({ ...policy(), allowed_merchants: [{ id: 'a' }, { id: 'a' }] })).toThrow();
    for (const value of ['0', '-1', 'NaN', '1e3', '1.001', '01', '1000000000']) {
      expect(() => intent(value)).toThrow();
    }
    expect(() => PaymentIntentSchema.parse({ ...intent(), rail: 'usdc' })).toThrow();
  });
  it('does not let legacy intents bypass explicit owner routing constraints', () => {
    const p = PolicySchema.parse({ ...policy(), routing: { allowed_rails: ['ledger'] } });
    expect(evaluate(intent(), p, history()).decision).toBe('deny');
    expect(evaluate(intent(), p, history(), { routed: true }).decision).toBe('allow');
  });
});
