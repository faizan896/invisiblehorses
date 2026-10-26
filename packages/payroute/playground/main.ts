import './style.css';
import { createRouter, Counterparties, defaultAdapters, PolicySchema, PaymentIntentV2Schema, type Scoring, type RoutePlan, type Alternative } from '../src/index.js';
import catalog from '../examples/counterparties.json' with { type: 'json' };

const profiles = new Counterparties(catalog);
const form = document.querySelector<HTMLFormElement>('#intent-form')!;
const field = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
const names: Record<string, string> = { ledger: 'Internal ledger', 'ach-mock': 'ACH bank transfer', 'usdc-base-sepolia': 'USDC · Base Sepolia', 'wise-quote': 'Wise-style bank' };
const labels: Record<string, string> = { ledger: 'INTERNAL TEST LEDGER', 'ach-mock': 'SIMULATED · US DOMESTIC', 'usdc-base-sepolia': 'MODELED · TESTNET ONLY', 'wise-quote': 'MOCK · NO WISE API' };
const money = (v: string) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (v: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v)) + ' UTC';
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') { const e = document.createElement(tag); e.className = className; e.textContent = text; return e; }

function quoteCard(a: Alternative, selected: boolean) {
  const q = a.quote, card = element('article', `quote-card ${selected ? 'selected' : ''} ${q ? '' : 'unavailable'}`);
  const title = element('div', 'quote-title'); title.append(element('h4', '', names[a.rail] ?? a.rail), element('span', `state ${a.eligible ? '' : 'rejected'}`, selected ? 'Chosen' : a.eligible ? 'Eligible' : 'Excluded')); card.append(title, element('p', 'quote-kind', labels[a.rail] ?? 'TEST ADAPTER'));
  if (q) {
    const values = element('div', 'quote-numbers');
    for (const [label, value] of [['All-in cost', money(q.total_all_in_cost.amount)], ['Fees', money(q.total_fee_usd)]]) { const cell = element('div'); cell.append(element('small', '', label), element('strong', '', value)); values.append(cell); }
    card.append(values, element('p', 'availability', `Usable ${date(q.expected_available_at)} · latest ${date(q.latest_available_at)}\n${Math.round(q.certainty * 100)}% modeled certainty · ${q.reversibility}`));
  }
  if (a.reasons.length) { const reasons = element('div', q ? 'reasons' : 'unavailable-text'); for (const reason of a.reasons) reasons.append(element('p', '', reason)); card.append(reasons); }
  return card;
}
function render(plan: RoutePlan) {
  const chosen = document.querySelector('#chosen')!, q = plan.selected;
  const card = element('article', `chosen-card ${q ? '' : 'denied-card'}`);
  if (q) {
    const label = element('div', 'chosen-label'); label.append(element('span', 'dot'), element('span', '', 'RECOMMENDED ROUTE'));
    const top = element('div', 'chosen-top'), price = element('div', 'chosen-price', money(q.total_all_in_cost.amount)); price.append(element('small', '', 'all-in USD')); top.append(element('h3', '', names[q.rail] ?? q.rail), price);
    const flow = element('div', 'route-flow'); flow.append(element('span', '', 'USD source'), element('span', '', '→'));
    q.steps.forEach((s, i) => { if (i) flow.append(element('span', '', '→')); flow.append(element('b', '', s.kind)); }); flow.append(element('span', '', '→'), element('span', '', `${q.recipient_amount.amount} ${q.recipient_amount.currency} · ${q.destination_form}`));
    card.append(label, top, flow, element('p', 'chosen-reason', `${q.explanation} Funds expected ${date(q.expected_available_at)}. ${plan.reasons.at(-1)}.`));
    if (plan.decision === 'needs_approval') card.append(element('span', 'approval-flag', 'Owner approval required before payment'));
  } else { card.append(element('div', 'chosen-label', 'NO ELIGIBLE ROUTE'), element('h3', '', 'These constraints cannot be met.'), element('p', '', plan.reasons.join(' · '))); }
  chosen.replaceChildren(card);
  document.querySelector('#quotes')!.replaceChildren(...plan.alternatives.map(a => quoteCard(a, !!q && a.quote?.id === q.id)));
  document.querySelector('#quote-count')!.textContent = `${plan.alternatives.filter(a => a.quote).length} quotes compared`;
}
async function update() {
  const results = document.querySelector('.results')!; results.setAttribute('aria-busy', 'true');
  try {
    const now = `${field('day').value}T${field('time').value}:00Z`, currency = field('currency').value;
    document.querySelector('#recipient-name')!.textContent = `Fictional recipient: ${currency === 'MXN' ? 'Norte Manufacturing' : currency === 'EUR' ? 'Euro Data · KYB pending' : 'DataCo'}`;
    document.querySelector('#bank-time')!.textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(now)) + ' · bank cutoff 4 pm New York';
    const policy = PolicySchema.parse({ max_per_payment: '30000', max_per_day: '50000', new_merchant_max: '30000', require_approval_above: '100', expires_at: '2030-01-01T00:00:00Z', allowed_merchants: [{ id: 'dataco' }, { id: 'norte' }, { id: 'euro-data' }], routing: {} });
    const i = PaymentIntentV2Schema.parse({ idempotency_key: 'playground-preview', payer: 'research-agent-07', recipient: currency === 'MXN' ? 'norte' : currency === 'EUR' ? 'euro-data' : 'dataco', amount: field('amount').value, destination_currency: currency, deadline: `${field('deadline').value}:00Z`, purpose: 'Playground route preview', max_fee: field('max-fee').value, reversibility_requirement: field('reversibility').value, recipient_preferences: { delivery: field('delivery').value, avoid_stablecoins: (field('avoid-stablecoins') as HTMLInputElement).checked } });
    const router = createRouter({ rails: defaultAdapters(), scoring: field('scoring').value as Scoring, context: intent => ({ payer: profiles.get(intent.payer), recipient: profiles.get(intent.recipient), policy, history: { now, spent_today: '0', paid_merchants: [] } }) });
    render(await router.plan(i));
  } catch {
    const card = element('article', 'chosen-card denied-card'); card.append(element('h3', '', 'Check the intent.'), element('p', '', 'Use a positive amount, valid dates and times, and a fee ceiling with at most two decimal places. Supported currencies: USD, MXN and EUR.'));
    document.querySelector('#chosen')!.replaceChildren(card); document.querySelector('#quotes')!.replaceChildren(); document.querySelector('#quote-count')!.textContent = '';
  } finally { results.setAttribute('aria-busy', 'false'); }
}
form.addEventListener('submit', e => { e.preventDefault(); void update(); });
const scenarios: Record<string, Record<string, string>> = {
  domestic: { amount: '10.00', currency: 'USD', delivery: 'any', day: '2026-10-27', time: '14:00' },
  monday: { amount: '250000.00', currency: 'MXN', delivery: 'bank', day: '2026-10-26', time: '22:00' },
  tuesday: { amount: '250000.00', currency: 'MXN', delivery: 'bank', day: '2026-10-27', time: '14:00' },
  refund: { amount: '25.00', currency: 'USD', delivery: 'any', day: '2026-10-27', time: '14:00', scoring: 'most-certain', reversibility: 'preferred' },
  weekend: { amount: '10.00', currency: 'USD', delivery: 'bank', day: '2026-10-31', time: '14:00' },
  holiday: { amount: '10.00', currency: 'USD', delivery: 'bank', day: '2026-11-26', time: '15:00', deadline: '2026-12-05T23:00' },
};
document.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  form.reset(); document.querySelectorAll('[data-scenario]').forEach(b => b.classList.remove('active')); button.classList.add('active');
  for (const [id, value] of Object.entries(scenarios[button.dataset.scenario!]!)) field(id).value = value;
  void update();
}));
void update();
