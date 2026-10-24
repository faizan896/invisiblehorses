import { z } from 'zod';
import { getAddress, isAddress } from 'viem';

export const MoneySchema = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/, 'Use a decimal USD string with at most two decimal places');
export const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/);
export const AddressSchema = z.string().refine((v) => isAddress(v, { strict: true }) && !/^0x0{40}$/i.test(v), 'Expected a nonzero Ethereum address').transform((v) => getAddress(v));
export const PaymentIntentSchema = z.strictObject({
  idempotency_key: IdSchema,
  payer: IdSchema,
  recipient: z.strictObject({
    id: IdSchema, name: z.string().trim().min(1).max(120), address: AddressSchema,
    category: z.string().min(1).max(40).optional(),
  }),
  amount: MoneySchema.refine((v) => minor(v) > 0, 'Amount must be positive'),
  purpose: z.string().trim().min(1).max(500),
  metadata: z.record(z.string().max(80), z.string().max(500)).refine((v) => Object.keys(v).length <= 20).optional(),
});
export type PaymentIntent = z.infer<typeof PaymentIntentSchema>;
export function minor(value: string): number {
  const parsed = MoneySchema.parse(value);
  const [whole, fractional = ''] = parsed.split('.');
  return Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
}
export function decimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Invalid minor amount');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
