import { z } from 'zod';
import { RailIdSchema } from '../rails/adapter.js';
export const RoutingRulesSchema = z.strictObject({
  strategy: z.enum(['lowest_cost', 'fastest', 'refund_certainty']).default('lowest_cost'),
  allowed_rails: z.array(RailIdSchema).default(['ledger', 'ach-mock', 'usdc-base-sepolia', 'wise-quote']),
  blocked_countries: z.array(z.string().regex(/^[A-Z]{2}$/)).default([]),
  require_kyb: z.literal(true).default(true),
  min_certainty: z.number().min(0).max(1).default(0),
});
export type RoutingRules = z.infer<typeof RoutingRulesSchema>;
