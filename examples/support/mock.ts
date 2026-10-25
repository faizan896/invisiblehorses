import { keccak256, toHex, type Hex } from 'viem';
import type { PaymentIntent } from '../../src/intent/schema.js';
import type { TestnetExecutor, ReceiptState } from '../../src/rails/testnet.js';
import type { Notifier, ApprovalNotification } from '../../src/approval/notifier.js';

/** OFFLINE MOCK ONLY. Never instantiated by the production CLI. No chain/notification I/O. */
export class MockTestnetExecutor implements TestnetExecutor {
  prepared = 0;
  readonly preparedIntents: PaymentIntent[] = [];
  readonly broadcasts = new Set<Hex>();
  failPrepare = false;
  ambiguousBroadcast = false;
  reverted = false;
  async assertTestnet() {}
  async prepare(intent: PaymentIntent) {
    if (this.failPrepare) throw new Error('Simulated gas estimation failure');
    this.prepared++;
    this.preparedIntents.push(structuredClone(intent));
    const raw = toHex(JSON.stringify({ intent, sequence: this.prepared }));
    return { raw, hash: keccak256(raw) };
  }
  async broadcast(raw: Hex) {
    const hash = keccak256(raw); this.broadcasts.add(hash);
    if (this.ambiguousBroadcast) throw new Error('Simulated timeout AFTER network acceptance');
    return hash;
  }
  async receipt(hash: Hex): Promise<ReceiptState> {
    return this.broadcasts.has(hash) ? this.reverted ? 'reverted' : 'success' : 'pending';
  }
}
export class RecordingNotifier implements Notifier {
  readonly notifications: ApprovalNotification[] = [];
  fail = false;
  async notify(n: ApprovalNotification) {
    if (this.fail) throw new Error('Simulated ntfy outage');
    this.notifications.push(n);
  }
}
