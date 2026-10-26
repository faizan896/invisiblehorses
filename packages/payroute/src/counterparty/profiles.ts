import { z } from 'zod';
import { AddressSchema, IdSchema } from '../intent/schema.js';
import { CurrencySchema } from '../intent/routing.js';
import { AppError } from '../errors.js';

export const CounterpartySchema = z.strictObject({
  id: IdSchema, name: z.string().min(1).max(120), country: z.string().regex(/^[A-Z]{2}$/),
  preferred_currency: CurrencySchema, test_profile: z.literal(true),
  categories: z.array(z.string().min(1).max(40)).default([]),
  internal_account: z.string().regex(/^test:/).optional(),
  bank_accounts: z.array(z.strictObject({
    id: IdSchema, country: z.string().regex(/^[A-Z]{2}$/), currency: CurrencySchema,
    reference: z.string().regex(/^TEST-/), status: z.enum(['open', 'closed']),
  })),
  stablecoin_wallets: z.array(z.strictObject({ chain_id: z.literal(84532), address: AddressSchema })),
  kyb_status: z.enum(['verified', 'pending', 'rejected']),
  payment_preferences: z.array(z.enum(['internal', 'bank', 'wallet'])).min(1),
});
export type Counterparty = z.infer<typeof CounterpartySchema>;
const Catalog = z.array(CounterpartySchema).min(1).refine((p) => new Set(p.map((v) => v.id)).size === p.length, 'Duplicate counterparty IDs');
export class Counterparties {
  private readonly profiles: Counterparty[];
  constructor(input: unknown, private readonly reload?: () => unknown) { this.profiles = Catalog.parse(input); }
  static from(loader: () => unknown) { return new Counterparties(loader(), loader); }
  private current() { return this.reload ? Catalog.parse(this.reload()) : this.profiles; }
  withWallets(input: Record<string, string>) {
    const wallets = z.record(IdSchema, AddressSchema).parse(input);
    return Counterparties.from(() => this.list().map((p) => wallets[p.id] ? { ...p, stablecoin_wallets: [{ chain_id: 84532, address: wallets[p.id] }] } : p));
  }
  get(id: string): Counterparty {
    const result = this.current().find((p) => p.id === IdSchema.parse(id));
    if (!result) throw new AppError(404, 'Counterparty not found in the owner catalog');
    return structuredClone(result);
  }
  list() { return structuredClone(this.current()); }
}
