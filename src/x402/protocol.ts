import { z } from 'zod';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { PaymentRequiredV2Schema } from '@x402/core/schemas';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { ClientEvmSigner } from '@x402/evm';
import { AddressSchema } from '../intent/schema.js';
import { TEST_USDC } from '../rails/usdc-base-sepolia.js';

export const X402_NETWORK = 'eip155:84532' as const;
const Requirement = z.object({
  scheme: z.literal('exact'), network: z.literal(X402_NETWORK), asset: AddressSchema,
  amount: z.string().regex(/^[1-9][0-9]{0,19}$/), payTo: AddressSchema,
  maxTimeoutSeconds: z.number().int().min(1).max(300),
  extra: z.object({ name: z.literal('USDC'), version: z.literal('2'), assetTransferMethod: z.literal('eip3009').optional(), paymentFlow: z.literal('authorization').optional() }).passthrough(),
});
export type ParsedRequirements = { challenge: PaymentRequired; selected: PaymentRequirements; cents: number };
export function unitsToCents(value: string) {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new Error('Expected a positive integer atomic USDC amount');
  const cents = (BigInt(value) + 9999n) / 10000n;
  if (cents > 99999999999n) throw new Error('USDC amount exceeds supported policy accounting range');
  return Number(cents);
}
export function parseRequirements(url: string, response: Response): ParsedRequirements {
  const header = response.headers.get('PAYMENT-REQUIRED');
  if (response.status !== 402 || !header || header.length > 32768) throw new Error('Missing or oversized x402 v2 PAYMENT-REQUIRED header');
  const http = new x402HTTPClient(new x402Client());
  const challenge = PaymentRequiredV2Schema.parse(http.getPaymentRequiredResponse(name => response.headers.get(name))) as PaymentRequired;
  if (new URL(challenge.resource.url).toString() !== new URL(url).toString()) throw new Error('Payment requirements describe a different resource');
  const eligible = challenge.accepts.flatMap(raw => {
    const r = Requirement.safeParse(raw);
    if (!r.success || r.data.asset.toLowerCase() !== TEST_USDC.toLowerCase()) return [];
    return [r.data as PaymentRequirements];
  }).sort((a, b) => BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0);
  const selected = eligible[0];
  if (!selected) throw new Error('Only x402 v2 exact EIP-3009 Base Sepolia USDC with the verified token domain is supported');
  return { challenge: { ...challenge, accepts: [selected] }, selected, cents: unitsToCents(selected.amount) };
}
const Receipt = z.object({ success: z.literal(true), transaction: z.string().regex(/^0x[a-fA-F0-9]{64}$/), network: z.literal(X402_NETWORK), payer: AddressSchema.optional(), amount: z.string().optional() });
export class ExactProtocol {
  readonly address: `0x${string}`;
  constructor(private readonly options: {
    signer: ClientEvmSigner; assertTestnet: () => Promise<void>;
    verifySettlement: (receipt: SettleResponse, requirements: PaymentRequirements, payload?: PaymentPayload) => Promise<boolean>;
  }) { this.address = options.signer.address; }
  async assertTestnet() { await this.options.assertTestnet(); }
  async create(parsed: ParsedRequirements): Promise<{ payload: PaymentPayload; header: string }> {
    await this.assertTestnet();
    const signer: ClientEvmSigner = { address: this.address, signTypedData: async args => {
      if (Number(args.domain.chainId) !== 84532 || String(args.domain.verifyingContract).toLowerCase() !== TEST_USDC.toLowerCase() || args.primaryType !== 'TransferWithAuthorization' || args.domain.name !== 'USDC' || args.domain.version !== '2') throw new Error('Refusing signing outside the fixed Base Sepolia USDC authorization');
      await this.assertTestnet();
      return this.options.signer.signTypedData(args);
    } };
    const client = new x402Client().register(X402_NETWORK, new ExactEvmScheme(signer));
    client.setSpendControls({ allowedAssets: [{ network: X402_NETWORK, asset: TEST_USDC, maxAmountPerPayment: parsed.selected.amount }] });
    const http = new x402HTTPClient(client);
    const payload = await http.createPaymentPayload({ ...parsed.challenge, accepts: [parsed.selected] });
    const headers = http.encodePaymentSignatureHeader(payload);
    const header = headers['PAYMENT-SIGNATURE'];
    if (!header) throw new Error('Official x402 client did not construct a v2 payment header');
    return { payload, header };
  }
  readReceipt(response: Response, requirements: PaymentRequirements): SettleResponse {
    const header = response.headers.get('PAYMENT-RESPONSE');
    if (!header || header.length > 32768) throw new Error('Missing or oversized x402 settlement receipt');
    const receipt = Receipt.parse(decodePaymentResponseHeader(header));
    if (receipt.payer && receipt.payer.toLowerCase() !== this.address.toLowerCase()) throw new Error('Settlement receipt belongs to a different payer');
    if (receipt.amount && receipt.amount !== requirements.amount) throw new Error('Exact settlement amount mismatch');
    return receipt;
  }
  async confirmReceipt(input: SettleResponse, requirements: PaymentRequirements, payload?: PaymentPayload): Promise<SettleResponse> {
    const receipt = Receipt.parse(input);
    if (receipt.payer && receipt.payer.toLowerCase() !== this.address.toLowerCase()) throw new Error('Settlement receipt belongs to a different payer');
    if (receipt.amount && receipt.amount !== requirements.amount) throw new Error('Exact settlement amount mismatch');
    await this.assertTestnet();
    if (!await this.options.verifySettlement(receipt, requirements, payload)) throw new Error('Settlement could not be independently confirmed');
    return receipt;
  }
  async confirm(response: Response, requirements: PaymentRequirements) { return this.confirmReceipt(this.readReceipt(response, requirements), requirements); }
}
