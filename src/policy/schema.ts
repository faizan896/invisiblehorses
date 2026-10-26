import { z } from 'zod';
import { AddressSchema, IdSchema, MoneySchema, minor } from '../intent/schema.js';
import { RoutingRulesSchema } from './routing.js';
import { X402PolicySchema } from '../x402/schema.js';

const Limit = z.union([MoneySchema, z.number().finite().nonnegative().transform(String).pipe(MoneySchema)]);
export const PolicySchema = z.strictObject({
  max_per_payment: Limit, max_per_day: Limit, new_merchant_max: Limit,
  require_approval_above: Limit,
  expires_at: z.iso.datetime(),
  routing: RoutingRulesSchema.optional(),
  x402: X402PolicySchema.optional(),
  allowed_merchants: z.array(z.strictObject({
    id: IdSchema, address: AddressSchema.optional(), categories: z.array(z.string().min(1)).optional(),
  })).min(1),
}).superRefine((p, ctx) => {
  if (new Set(p.allowed_merchants.map((m) => m.id)).size !== p.allowed_merchants.length) {
    ctx.addIssue({ code: 'custom', message: 'Merchant IDs must be unique' });
  }
  if (minor(p.new_merchant_max) > minor(p.max_per_payment)) {
    ctx.addIssue({ code: 'custom', message: 'New merchant limit must not exceed the hard payment limit' });
  }
});
export type Policy = z.infer<typeof PolicySchema>;
