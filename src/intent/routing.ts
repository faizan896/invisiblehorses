import { z } from 'zod';
import { IdSchema, MoneySchema, minor } from './schema.js';

export const CurrencySchema = z.enum(['USD', 'MXN', 'EUR']);
export const DeliverySchema = z.enum(['any', 'internal', 'bank', 'wallet']);
/** Full destination-denominated intent. The older USD-only API remains readable/idempotent. */
export const PaymentIntentV2Schema = z.strictObject({
  idempotency_key: IdSchema, payer: IdSchema, recipient: IdSchema,
  amount: MoneySchema.refine((value) => minor(value) > 0, 'Amount must be positive'),
  destination_currency: CurrencySchema,
  deadline: z.iso.datetime(), purpose: z.string().trim().min(1).max(500),
  max_fee: MoneySchema,
  reversibility_requirement: z.enum(['none', 'preferred', 'required']),
  recipient_preferences: z.strictObject({
    delivery: DeliverySchema.default('any'), avoid_stablecoins: z.boolean().default(false),
  }).default({ delivery: 'any', avoid_stablecoins: false }),
  metadata: z.record(z.string().max(80), z.string().max(500)).refine((v) => Object.keys(v).length <= 20).default({}),
});
export type RoutingIntent = z.infer<typeof PaymentIntentV2Schema>;
