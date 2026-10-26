import { createHash } from 'node:crypto';
import type { PaymentRequirements } from '@x402/core/types';
import type { Policy } from '../policy/schema.js';
import type { Evaluation, PolicyHistory } from '../policy/engine.js';
import { minor } from '../intent/schema.js';
import type { PaidResourceRequest } from './schema.js';
import { unitsToCents } from './protocol.js';

/** Explicit owner host allowlisting is required in addition to these URL checks. */
export function canonicalResourceUrl(input: string, allowLoopback = false) {
  const u = new URL(input), host = u.hostname.toLowerCase();
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (u.username || u.password || u.hash || input.length > 2000) throw new Error('Resource URL must not contain credentials or a fragment');
  if (allowLoopback && loopback && ['http:', 'https:'].includes(u.protocol)) return u.toString();
  if (u.protocol !== 'https:' || /^[0-9.]+$/.test(host) || host.startsWith('[') || !host.includes('.') || /\.(localhost|local|internal)$/.test(host)) throw new Error('Only explicitly allowed public HTTPS resource hosts are supported');
  return u.toString();
}
export const x402MerchantId = (host: string) => 'x402:' + createHash('sha256').update(host.toLowerCase()).digest('hex');

export function evaluateX402(input: {
  request: PaidResourceRequest; requirements: PaymentRequirements; policy: Policy;
  history: PolicyHistory; api_spent_today: string; allowLoopback?: boolean;
}): Evaluation {
  const { request, requirements, policy, history } = input, reasons: string[] = [];
  let host = '';
  try { host = new URL(canonicalResourceUrl(request.url, input.allowLoopback)).host; } catch { reasons.push('Resource URL is not an allowed public HTTPS destination'); }
  const rules = policy.x402;
  if (!rules) return { decision: 'deny', reasons: ['Owner x402 policy is not configured'] };
  const merchant = rules.allowed_hosts.find(h => h.host.toLowerCase() === host);
  if (!merchant) reasons.push('Resource host is not in the owner x402 allowlist');
  if (merchant && !rules.categories.includes(merchant.category)) reasons.push('Resource host category is not allowed by the owner');
  const now = Date.parse(history.now);
  if (!Number.isFinite(now) || now >= Date.parse(policy.expires_at)) reasons.push('Owner policy has expired or the clock is invalid');
  const amount = unitsToCents(requirements.amount);
  if (BigInt(requirements.amount) > BigInt(minor(request.max_price)) * 10000n) reasons.push('Merchant price exceeds the caller max_price');
  if (amount > minor(rules.max_per_request)) reasons.push(`Owner x402 per-request limit is $${rules.max_per_request}`);
  if (amount + minor(input.api_spent_today) > minor(rules.max_per_day)) reasons.push(`Owner daily API spending limit is $${rules.max_per_day}`);
  if (amount > minor(policy.max_per_payment)) reasons.push(`Hard per-payment limit is $${policy.max_per_payment}`);
  if (amount + minor(history.spent_today) > minor(policy.max_per_day)) reasons.push(`Shared owner daily limit is $${policy.max_per_day}`);
  const trusted = history.paid_merchants.includes(`${x402MerchantId(host)}:${requirements.payTo.toLowerCase()}`);
  if (!trusted && amount > minor(policy.new_merchant_max)) reasons.push(`New merchant limit is $${policy.new_merchant_max}`);
  if (reasons.length) return { decision: 'deny', reasons };
  if (amount > minor(policy.require_approval_above)) return { decision: 'needs_approval', reasons: [`Human approval required above $${policy.require_approval_above}`] };
  return { decision: 'allow', reasons: ['Owner x402 host, category, price and shared spending rules passed'] };
}
