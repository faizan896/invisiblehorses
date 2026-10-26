import { minor, type PaymentIntent } from '../intent/schema.js';
import type { Policy } from './schema.js';

export type PolicyHistory = { now: string; spent_today: string; paid_merchants: string[] };
export type Evaluation = { decision: 'allow' | 'needs_approval' | 'deny'; reasons: string[] };

/** Pure deterministic rules. Money is compared in integer cents; history includes reservations. */
export function evaluate(intent: PaymentIntent, policy: Policy, history: PolicyHistory, context?: { routed: true }): Evaluation {
  const reasons: string[] = [];
  const amount = minor(intent.amount);
  const now = Date.parse(history.now);
  if (policy.routing && !context?.routed) reasons.push('Owner routing rules require a full counterparty intent; the legacy USD-only API cannot bypass them');
  if (!Number.isFinite(now) || now >= Date.parse(policy.expires_at)) reasons.push('Policy has expired or the evaluation clock is invalid');
  if (amount > minor(policy.max_per_payment)) reasons.push(`Hard per-payment limit is $${policy.max_per_payment}`);
  if (amount + minor(history.spent_today) > minor(policy.max_per_day)) reasons.push(`Daily limit is $${policy.max_per_day}; $${history.spent_today} is already spent or reserved today (UTC)`);
  const merchant = policy.allowed_merchants.find((m) => m.id === intent.recipient.id);
  if (!merchant) reasons.push('Merchant is not in the owner allowlist');
  if (merchant?.categories && (!intent.recipient.category || !merchant.categories.includes(intent.recipient.category))) reasons.push('Merchant category is not allowed');
  if (merchant?.address && merchant.address.toLowerCase() !== intent.recipient.address.toLowerCase()) reasons.push('Recipient address differs from the owner-approved address');
  // Trust history binds identity AND destination; changing wallets is a new merchant destination.
  if (!history.paid_merchants.includes(`${intent.recipient.id}:${intent.recipient.address.toLowerCase()}`) && amount > minor(policy.new_merchant_max)) reasons.push(`New merchant limit is $${policy.new_merchant_max}`);
  if (reasons.length) return { decision: 'deny', reasons };
  if (amount > minor(policy.require_approval_above)) return { decision: 'needs_approval', reasons: [`Human approval required above $${policy.require_approval_above}`] };
  return { decision: 'allow', reasons: ['All owner policy rules passed'] };
}
