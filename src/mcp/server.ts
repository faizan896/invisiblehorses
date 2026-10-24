import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PaymentIntentSchema } from '../intent/schema.js';

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
    description: 'Request a TEST USDC payment on Base Sepolia. Owner policy is mandatory. Reuse the idempotency key for retries. Approval tokens and owner controls are never exposed.',
    inputSchema: PaymentIntentSchema,
  }, async (input) => call('/api/payments', PaymentIntentSchema.parse(input)));
  server.registerTool('get_payment_status', { description: 'Read one of this agent’s payments', inputSchema: Status }, async ({ payment_id }) => call(`/api/payments/${payment_id}`));
  server.registerTool('list_payments', { description: 'List this agent’s payments', inputSchema: List }, async ({ limit }) => call(`/api/payments?limit=${limit}`));
  server.registerTool('get_my_limits', { description: 'Read owner policy and remaining daily allowance', inputSchema: z.strictObject({}) }, async () => call('/api/limits'));
  return server;
}
