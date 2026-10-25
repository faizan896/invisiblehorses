import type { PaymentStatus } from '../audit/store.js';
import type { RailExecution, RouteQuote } from '../rails/adapter.js';
import type { RoutingIntent } from '../intent/routing.js';
import { minor } from '../intent/schema.js';

const graph: Partial<Record<PaymentStatus, PaymentStatus[]>> = {
  created: ['recipient_resolved', 'denied', 'failed'],
  recipient_resolved: ['route_selected', 'denied', 'failed'],
  route_selected: ['funds_reserved', 'denied', 'failed'],
  funds_reserved: ['pending_approval', 'in_transit', 'denied', 'failed', 'route_selected'],
  pending_approval: ['funds_reserved', 'rejected', 'expired', 'denied'],
  in_transit: ['settled', 'route_selected', 'failed', 'returned'],
  settled: ['completed', 'returned', 'failed'],
  completed: ['settled', 'returned'],
  failed: ['settled', 'returned'],
};
export function assertTransition(from: PaymentStatus, to: PaymentStatus) {
  if (!graph[from]?.includes(to)) throw new Error(`Illegal payment transition ${from} -> ${to}`);
}
export function safeFallback(intent: RoutingIntent, next: RouteQuote, previous: RailExecution, approvedUsd: number | null) {
  const reasons: string[] = [];
  if (previous.irreversible || previous.funds_may_have_left !== false) reasons.push('Funds may already have left; fallback could pay twice');
  if (previous.fx_exposure !== false) reasons.push('Open or unknown FX exposure prevents fallback');
  if (minor(previous.charged_fee_usd ?? '0') !== 0) reasons.push('The failed route charged fees; automatic fallback would change the authorized cost');
  if (next.recipient_amount.currency !== intent.destination_currency || minor(next.recipient_amount.amount) !== minor(intent.amount)) reasons.push('Fallback would change recipient amount or currency');
  if (intent.recipient_preferences.delivery !== 'any' && next.destination_form !== intent.recipient_preferences.delivery) reasons.push('Fallback would change requested funds form');
  if (approvedUsd !== null && minor(next.total_all_in_cost.amount) > approvedUsd) reasons.push('Fallback exceeds the amount approved by the owner');
  return { safe: reasons.length === 0, reasons };
}
export class RouteFailure extends Error {
  constructor(message: string, readonly outcome: RailExecution) { super(message); }
}
export class WalletBusy extends Error {}
