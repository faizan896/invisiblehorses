import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RequestSchema } from '../intent/request.js';
import { PaymentIntentSchema } from '../intent/schema.js';
import { PaymentIntentV2Schema } from '../intent/routing.js';
import { PaidResourceRequestSchema } from '../x402/schema.js';

// SDK tool discovery normalizes object schemas; a root union loses its fields.
const RequestToolSchema = z.strictObject({ ...PaymentIntentSchema.shape, recipient: z.union([PaymentIntentSchema.shape.recipient, PaymentIntentV2Schema.shape.recipient]), destination_currency: PaymentIntentV2Schema.shape.destination_currency.optional(), deadline: PaymentIntentV2Schema.shape.deadline.optional(), max_fee: PaymentIntentV2Schema.shape.max_fee.optional(), reversibility_requirement: PaymentIntentV2Schema.shape.reversibility_requirement.optional(), recipient_preferences: PaymentIntentV2Schema.shape.recipient_preferences.removeDefault().optional() }).superRefine((v, ctx) => { if (!RequestSchema.safeParse(v).success) ctx.addIssue({ code: 'custom', message: 'Use a complete destination-denominated intent or the legacy wallet intent' }); });

const Status = z.strictObject({ payment_id: z.uuid() });
const List = z.strictObject({ limit: z.number().int().min(1).max(200).default(100) });
export function createMcpServer(apiUrl: string, agentToken: string) {
  const server = new McpServer({ name: 'railgate', version: '0.1.0' });
  const call = async (path: string, input?: unknown) => {
    try {
      const response = await fetch(new URL(path, apiUrl), {
        method: input ? 'POST' : 'GET', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${agentToken}`, ...(input ? { 'Content-Type': 'application/json' } : {}) },
        body: input ? JSON.stringify(input) : undefined,
      });
      const result: unknown = await response.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: !response.ok };
    } catch { return { content: [{ type: 'text' as const, text: 'railgate service unavailable; retry with the SAME idempotency key' }], isError: true }; }
  };
  server.registerTool('request_payment', {
    description: 'Request a TEST payment using a catalog recipient ID and destination amount/currency. The owner router chooses the rail. Owner policy is mandatory. Reuse the idempotency key for retries. Approval tokens and owner controls are never exposed.',
    inputSchema: RequestToolSchema,
  }, async (input) => call('/api/payments', RequestSchema.parse(input)));
  server.registerTool('get_payment_status', { description: 'Read one of this agent’s payments', inputSchema: Status }, async ({ payment_id }) => call(`/api/payments/${payment_id}`));
  server.registerTool('list_payments', { description: 'List this agent’s payments', inputSchema: List }, async ({ limit }) => call(`/api/payments?limit=${limit}`));
  server.registerTool('get_my_limits', { description: 'Read owner policy and remaining daily allowance', inputSchema: z.strictObject({}) }, async () => call('/api/limits'));
  server.registerTool('quote_payment', { description: 'Compare test-only payment quotes, fees and recipient availability. This read-only tool does not execute a payment. Specify the recipient catalog ID and destination amount/currency, never a rail.', inputSchema: PaymentIntentV2Schema }, async (input) => call('/api/quotes', PaymentIntentV2Schema.parse(input)));
  server.registerTool('plan_payment', { description: 'Plan a test-only payment using deterministic owner policy, compliance/eligibility gates and configured scoring. Stores a route explanation and alternatives; does not execute or approve payments.', inputSchema: PaymentIntentV2Schema }, async (input) => call('/api/routes', PaymentIntentV2Schema.parse(input)));
  server.registerTool('fetch_paid_resource', { description: 'Fetch a text/JSON GET resource using owner-approved x402 exact Base Sepolia TEST USDC. Merchant sets the price; max_price is a USD ceiling, never an offered price. Approval is owner-only. Reuse the same idempotency_key on retries; omitting it permits one logical purchase per agent and URL.', inputSchema: PaidResourceRequestSchema }, async input => call('/api/paid-resources', PaidResourceRequestSchema.parse(input)));
  return server;
}
