import { z } from 'zod';
import { IdSchema, MoneySchema } from '../intent/schema.js';

export const ApiCategory = z.enum(['data', 'inference', 'compute']);
const Limit = z.union([MoneySchema, z.number().finite().nonnegative().transform(String).pipe(MoneySchema)]);
export const X402PolicySchema = z.strictObject({
  max_per_request: Limit, max_per_day: Limit,
  allowed_hosts: z.array(z.strictObject({
    host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.-]+(?::[1-9][0-9]{0,4})?$/).transform(v => v.toLowerCase()),
    category: ApiCategory,
  })).min(1).max(100),
  categories: z.array(ApiCategory).min(1),
}).superRefine((p, ctx) => {
  if (new Set(p.allowed_hosts.map(h => h.host)).size !== p.allowed_hosts.length) ctx.addIssue({ code: 'custom', message: 'x402 hosts must be unique' });
});
export const PaidResourceRequestSchema = z.strictObject({
  url: z.url().max(2000), max_price: MoneySchema,
  purpose: z.string().trim().min(1).max(500), idempotency_key: IdSchema.optional(),
});
export type PaidResourceRequest = z.infer<typeof PaidResourceRequestSchema>;
