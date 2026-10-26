import { PolicySchema as BasePolicySchema } from 'payroute/policy/schema';
import { X402PolicySchema } from '../x402/schema.js';
import type { z } from 'zod';
export const PolicySchema = BasePolicySchema.safeExtend({ x402: X402PolicySchema.optional() });
export type Policy = z.infer<typeof PolicySchema>;
