import { config as dotenv } from 'dotenv';
import { z } from 'zod';
import { AddressSchema, PaymentIntentSchema } from '../../src/intent/schema.js';
import { configureProxy } from '../../src/network.js';

dotenv({ quiet: true }); configureProxy();
const cfg = z.object({
  RAILGATE_API_URL: z.url().default('http://127.0.0.1:3000'),
  AGENT_API_TOKEN: z.string().min(32), AGENT_ID: z.string().default('research-agent-07'),
  DEMO_RECIPIENT_ADDRESS: AddressSchema,
  DEMO_RUN_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
}).parse(process.env);
type Payment = { id: string; status: string; transaction_hash: string | null; evaluation: { reasons: string[] } };
async function api(path: string, body?: unknown): Promise<Payment> {
  const response = await fetch(new URL(path, cfg.RAILGATE_API_URL), { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${cfg.AGENT_API_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`railgate API returned HTTP ${response.status}`);
  return await response.json() as Payment;
}
function input(amount: string, step: string) {
  return PaymentIntentSchema.parse({ payer: cfg.AGENT_ID, idempotency_key: `${cfg.DEMO_RUN_ID}-${step}`, amount, recipient: { id: 'dataco', name: 'DataCo', category: 'data', address: cfg.DEMO_RECIPIENT_ADDRESS }, purpose: 'dataset access' });
}
async function wait(payment: Payment, milliseconds: number) {
  const deadline = Date.now() + milliseconds; let last = '';
  while (Date.now() < deadline) {
    const p = await api(`/api/payments/${payment.id}`);
    if (p.status !== last) { console.log(`Payment ${p.id}: ${p.status}`); last = p.status; }
    if (['completed', 'denied', 'rejected', 'expired', 'failed', 'uncertain'].includes(p.status)) return p;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('Still pending; inspect the dashboard and rerun with the SAME DEMO_RUN_ID. Do not create a replacement request.');
}
console.log('LIVE BASE SEPOLIA DEMO: spends test USDC only. Keep DEMO_RUN_ID unchanged when retrying.');
const five = await wait(await api('/api/payments', input('5', 'allowed')), 180_000);
if (five.status !== 'completed') throw new Error(`The $5 payment did not complete: ${five.evaluation.reasons.join('; ')}`);
console.log('(a) $5 completed, tx:', five.transaction_hash);
const approval = await api('/api/payments', input('45', 'approval'));
console.log('(b) Check ntfy and Approve or Reject; /approvals is the owner fallback.');
const decision = await wait(approval, 15 * 60_000 + 5000);
if (!['completed', 'rejected'].includes(decision.status)) throw new Error(`Approval example did not finish: ${decision.status}`);
const denied = await api('/api/payments', input('100', 'overspend'));
if (denied.status !== 'denied' || !denied.evaluation.reasons.some((r) => /daily/i.test(r))) throw new Error('Expected a daily-limit denial');
console.log('(c) Attempt exceeding daily budget denied:', denied.evaluation.reasons.join('; '));
const retry = await api('/api/payments', input('5', 'allowed'));
if (retry.id !== five.id || retry.transaction_hash !== five.transaction_hash) throw new Error('Idempotency check failed');
console.log('(d) Retry returned the same payment ID and transaction hash. Live demo passed.');
