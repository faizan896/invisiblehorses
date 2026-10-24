import type { PaymentIntent } from '../intent/schema.js';
export type ApprovalNotification = { paymentId: string; intent: PaymentIntent; approveUrl: string; rejectUrl: string; expiresAt: string };
export interface Notifier { notify(notification: ApprovalNotification): Promise<void> }

/** ntfy's documented JSON publishing API; no alternate messaging services. */
export class NtfyNotifier implements Notifier {
  constructor(private readonly server: string, private readonly topic: string, private readonly token?: string, private readonly fetcher: typeof fetch = fetch) {}
  async notify(n: ApprovalNotification) {
    const response = await this.fetcher(this.server, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({
        topic: this.topic, title: 'railgate · test USDC approval',
        message: `${n.intent.payer} wants to pay $${n.intent.amount} to ${n.intent.recipient.name} for '${n.intent.purpose}' (Base Sepolia TEST funds). Expires ${n.expiresAt}.`,
        actions: [
          { action: 'http', label: 'Approve', url: n.approveUrl, method: 'POST', clear: true },
          { action: 'http', label: 'Reject', url: n.rejectUrl, method: 'POST', clear: true },
        ],
      }),
    });
    if (!response.ok) throw new Error('ntfy delivery failed'); // Never log a response that could echo a capability URL.
  }
}
