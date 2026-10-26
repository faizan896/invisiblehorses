import { PaymentIntentV2Schema, type RoutingIntent } from './intent/routing.js';
import { QuoteService } from './rails/quotes.js';
import { Counterparties } from './counterparty/profiles.js';
import { planRoutes, preflight, type RoutingInput, type Scoring } from './router/engine.js';
import type { RailAdapter, RouteQuote } from './rails/adapter.js';

export type RoutingContext = Omit<RoutingInput, 'intent' | 'quotes' | 'unavailable'>;
export type RouterOptions = {
  rails: RailAdapter[];
  scoring?: Scoring;
  /** Trusted application/owner state. Never populate this from an agent's request body. */
  context: (intent: RoutingIntent) => RoutingContext | Promise<RoutingContext>;
};
/** Read-only planning. Execution and durable idempotency remain application-owned. */
export function createRouter(options: RouterOptions) {
  const ids = options.rails.map(r => r.id);
  if (new Set(ids).size !== ids.length) throw new Error('Rail adapter IDs must be unique');
  async function collect(input: unknown) {
    const intent = PaymentIntentV2Schema.parse(input), context = await options.context(intent);
    const hard = preflight({ ...context, intent });
    if (hard.length) return { intent, quotes: [] as RouteQuote[], unavailable: ids.map(rail => ({ rail, reason: hard.join('; ') })) };
    const service = new QuoteService(new Counterparties([context.payer, context.recipient].filter((v, i, all) => all.findIndex(x => x.id === v.id) === i)), options.rails, () => new Date(context.history.now));
    return service.quotes(intent, intent.payer);
  }
  return {
    async quote(intent: RoutingIntent): Promise<RouteQuote[]> { return (await collect(intent)).quotes; },
    async plan(input: RoutingIntent) {
      const result = await collect(input);
      // A sandbox quote may take seconds. Re-resolve policy/history after it returns.
      const context = await options.context(result.intent);
      return planRoutes({ ...context, ...result }, options.scoring);
    },
  };
}
