import type { Hex } from 'viem';
import type { PaymentIntent } from '../intent/schema.js';
export type SignedTransfer = { raw: Hex; hash: Hex };
export type ReceiptState = 'pending' | 'success' | 'reverted';
/** Guarded testnet transfer execution interface. */
export interface TestnetExecutor {
  assertTestnet(): Promise<void>;
  prepare(intent: PaymentIntent): Promise<SignedTransfer>;
  broadcast(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<ReceiptState>;
}
