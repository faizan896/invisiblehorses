import { describe, expect, it } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import { loadPolicy } from '../src/policy/loader.js';
import { canonicalResourceUrl, evaluateX402, x402MerchantId } from '../src/x402/policy.js';
import { TEST_USDC } from '../src/rails/usdc-base-sepolia.js';

const request = { url: 'https://api.example.test/weather', max_price: '1.00', purpose: 'weather lookup' };
const requirements: PaymentRequirements = { scheme: 'exact', network: 'eip155:84532', asset: TEST_USDC, amount: '10000', payTo: '0x0000000000000000000000000000000000000001', maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };
const policy = () => ({ ...loadPolicy('policies/example.yaml'), x402: { max_per_request: '1.00', max_per_day: '10.00', allowed_hosts: [{ host: 'api.example.test', category: 'data' as const }], categories: ['data' as const] } });
const history = { now: '2026-10-26T12:00:00Z', spent_today: '0.00', paid_merchants: [] as string[] };
const evaluate = (change: Partial<Parameters<typeof evaluateX402>[0]> = {}) => evaluateX402({ request, requirements, policy: policy(), history, api_spent_today: '0.00', ...change });

describe('x402 deterministic owner policy', () => {
  it('uses the merchant requirements amount, never the caller max_price, as the cost', () => {
    expect(evaluate().decision).toBe('allow');
    expect(evaluate({ requirements: { ...requirements, amount: '5000000' } })).toMatchObject({ decision: 'deny', reasons: expect.arrayContaining([expect.stringMatching(/per-request/i)]) });
    expect(evaluate({ request: { ...request, max_price: '0.00' } }).decision).toBe('deny');
  });
  it('fails closed without owner x402 configuration, for unknown hosts and disallowed categories', () => {
    expect(evaluate({ policy: loadPolicy('policies/example.yaml') }).decision).toBe('deny');
    expect(evaluate({ request: { ...request, url: 'https://other.example.test/weather' } }).decision).toBe('deny');
    expect(evaluate({ policy: { ...policy(), x402: { ...policy().x402, categories: ['compute'] } } }).decision).toBe('deny');
  });
  it('counts the shared owner budget and API budget, including other pending reservations', () => {
    expect(evaluate({ history: { ...history, spent_today: '99.99' } }).decision).toBe('allow');
    expect(evaluate({ history: { ...history, spent_today: '100.00' } }).decision).toBe('deny');
    expect(evaluate({ api_spent_today: '10.00' }).decision).toBe('deny');
    expect(evaluate({ policy: { ...policy(), expires_at: '2020-01-01T00:00:00Z' } }).decision).toBe('deny');
  });
  it('asks for approval only within hard gates and binds merchant trust to host plus payee', () => {
    const configured = { ...policy(), require_approval_above: '0.00' };
    expect(evaluate({ policy: configured }).decision).toBe('needs_approval');
    expect(evaluate({ policy: { ...configured, max_per_payment: '0.00' } }).decision).toBe('deny');
    expect(x402MerchantId('api.example.test')).not.toBe(x402MerchantId('other.example.test'));
    expect(evaluate({ policy: { ...policy(), new_merchant_max: '0.00' } }).decision).toBe('deny');
    expect(evaluate({ policy: { ...policy(), new_merchant_max: '0.00' }, history: { ...history, paid_merchants: [x402MerchantId('api.example.test') + ':' + requirements.payTo.toLowerCase()] } }).decision).toBe('allow');
  });
  it('rejects credentials, fragments, insecure URLs and private IP literals; local HTTP is an explicit fixture-only option', () => {
    for (const url of ['file:///etc/passwd', 'https://user:pass@api.example.test/', 'https://api.example.test/#fragment', 'http://api.example.test/', 'https://127.0.0.1/', 'https://169.254.169.254/', 'https://[::1]/']) expect(() => canonicalResourceUrl(url)).toThrow();
    expect(canonicalResourceUrl('https://API.EXAMPLE.TEST/weather')).toBe(request.url);
    expect(canonicalResourceUrl('http://127.0.0.1:4021/weather', true)).toBe('http://127.0.0.1:4021/weather');
    expect(() => canonicalResourceUrl('http://10.0.0.1/weather', true)).toThrow();
  });
});
