# Payroute playground numbers audit

Prices last checked: 2026-10-28. Planning tool with test data. Not a quote.

## Classification

(a) Live or official sandbox response. (b) Published public reference or rule, with URL and checked date. (c) Editable assumption. A calculated output inherits assumptions from its inputs. No official sandbox price is configured.

The audit covers every numeric output and the inputs that determine it. The original playground called no RPC or bank API: all its amounts, fees, timing and certainty were mock or modeled data. The new playground reads Base mainnet gas on load, and uses the published ECB snapshot below. No route becomes a live quote.

## Inputs and current defaults

| Number | Current value | Origin and classification |
| --- | --- | --- |
| MXN exchange rate | 18.630737 MXN per USD | (b) [ECB daily reference](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml), reference 2026-10-28, checked 2026-10-28. Derived cross-rate, rounded to six decimals; visitor edits become (c). Replaces 17. |
| EUR exchange rate | 0.89823 EUR per USD | (b) [ECB daily reference](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml), reference 2026-10-28, checked 2026-10-28. Derived cross-rate, rounded to six decimals; visitor edits become (c). Replaces 0.92. |
| ACH fixed fee | 0.25 USD | (c) Assumption. Fictional bank fee. Network wholesale fees do not establish a customer price. Editable in the Assumptions panel. |
| ACH variable fee | 0.1 % | (c) Assumption. Existing simulated bank fee, not a published customer tariff. Editable in the Assumptions panel. |
| ACH fee cap | 5 USD | (c) Assumption. Existing simulated bank fee cap. Editable in the Assumptions panel. |
| Bank transfer fixed fee | 0.5 USD | (c) Assumption. Generic cross-border bank model. No Wise quote is contacted. Editable in the Assumptions panel. |
| Bank transfer variable fee | 0.05 % | (c) Assumption. Generic model service fee. A real fee depends on corridor, funding and provider. Editable in the Assumptions panel. |
| Bank exchange-rate markup | 0.05 % | (c) Assumption. Generic bank model, not Wise. Wise publishes no separate mid-market markup; that does not establish another bank’s price. Editable in the Assumptions panel. |
| USDC funding fee | 0.05 % | (c) Assumption. No funding provider selected. Existing test funding assumption. Editable in the Assumptions panel. |
| USDC bank payout fixed fee | 1 USD | (c) Assumption. No payout provider selected; existing test assumption. Editable in the Assumptions panel. |
| USDC bank payout variable fee | 0.08 % | (c) Assumption. No payout provider selected. A chain transfer is not a bank payout. Editable in the Assumptions panel. |
| USDC exchange-rate markup | 0.1 % | (c) Assumption. No conversion provider selected; existing test assumption. Editable in the Assumptions panel. |
| USDC network allowance | 0.02 USD | (c) Assumption. Existing USD planning allowance. Base Sepolia uses test ETH. Live mainnet gas is shown separately and is not a transfer quote. Editable in the Assumptions panel. |
| Variable fee range | 20 % | (c) Assumption. Illustrative uncertainty around external fees, not measured market bounds. The router uses the central estimate; the upper range is not a fee guarantee. Editable in the Assumptions panel. |
| Bank opening hour | 9 Eastern hour | (c) Assumption. Provider working window assumption; FedNow and RTP do not share this restriction. Editable in the Assumptions panel. |
| Customer bank cutoff | 16 Eastern hour | (c) Assumption. Conservative provider assumption. FedACH’s final operator deadline is 16:45 Eastern. Editable in the Assumptions panel. |
| Bank expected wait | 1 banking days | (c) Assumption. Existing model delivery estimate after processing, not an SLA. Editable in the Assumptions panel. |
| Bank latest wait | 2 banking days | (c) Assumption. Existing model planning bound, not a guaranteed arrival. Editable in the Assumptions panel. |
| USDC bank payout wait | 2 hours | (c) Assumption. Existing payout estimate subject to assumed bank window. Does not model Mexican bank holidays. Editable in the Assumptions panel. |
| USDC payout after reopening | 10 Eastern hour | (c) Assumption. Existing assumed payout time on the next US banking day. Editable in the Assumptions panel. |
| USDC confirmation wait | 12 seconds | (c) Assumption. Existing modeled inclusion wait, not finality or bank delivery. Editable in the Assumptions panel. |
| Internal account wait | 0 seconds | (c) Assumption. Atomic test ledger model. No external money movement. Editable in the Assumptions panel. |
| Internal account fee | 0 USD | (c) Assumption. Free internal test transfer, not an external provider price. Editable in the Assumptions panel. |
| ACH certainty | 90 % | (c) Assumption. Uncalibrated model score, not an observed success rate or probability. Editable in the Assumptions panel. |
| Bank transfer certainty | 96 % | (c) Assumption. Uncalibrated model score, not an observed success rate or probability. Editable in the Assumptions panel. |
| USDC bank payout certainty | 94 % | (c) Assumption. Uncalibrated model score, not an observed success rate or probability. Editable in the Assumptions panel. |
| USDC wallet certainty | 99 % | (c) Assumption. Uncalibrated model score, not an observed success rate or probability. Editable in the Assumptions panel. |
| Internal account certainty | 100 % | (c) Assumption. Uncalibrated model score, not an observed success rate or probability. Editable in the Assumptions panel. |
| Available test liquidity | 1000000 USD | (c) Assumption. Fictional rail balance; no bank or wallet balance is read. Editable in the Assumptions panel. |
| Rail amount limit | 1000000 USD | (c) Assumption. Fictional provider limit, not a published network limit. Editable in the Assumptions panel. |
| Owner payment limit | 30000 USD | (c) Assumption. Demo owner policy, applied by the existing router. Editable in the Assumptions panel. |
| Owner daily limit | 50000 USD | (c) Assumption. Demo owner policy, applied by the existing router. Editable in the Assumptions panel. |
| Owner approval threshold | 100 USD | (c) Assumption. Demo owner policy. This page cannot approve or send a payment. Editable in the Assumptions panel. |
| Owner already spent today | 0 USD | (c) Assumption. Fictional account history. Editable in the Assumptions panel. |
| Owner policy expiration year | 2030 year, January 1 UTC | (c) Assumption. Fictional demo owner policy expiry, not a real account policy. Editable in the Assumptions panel. |
| Owner minimum certainty | 0 % | (c) Assumption. Demo policy gate, applied to uncalibrated model scores. Editable in the Assumptions panel. |
| Plan validity | 300 seconds | (c) Assumption. Existing five-minute test quote lifetime; no provider guarantees this validity. Editable in the Assumptions panel. |

## Published rules and live context

| Number or rule | Meaning | Source and class |
| --- | --- | --- |
| Federal Reserve: public rule | Same Day ACH operator submission deadlines: 10:30, 14:45 and 16:45 Eastern. These are not a customer bank cutoff or a promise of next-day delivery. | (b) [Official source](https://www.frbservices.org/resources/resource-centers/same-day-ach-resource-center/fedach-processing-schedule/), checked 2026-10-28. This rule does not establish a customer quote. |
| Federal Reserve: public rule | Federal Reserve holidays. Sunday holidays close the following Monday; Saturday holidays do not close the preceding Friday. Used for this US calendar only, not a Mexican bank calendar. | (b) [Official source](https://www.frbservices.org/about/holiday-schedules/), checked 2026-10-28. This rule does not establish a customer quote. |
| Federal Reserve: public rule | FedNow operates 24 hours a day, including weekends and holidays. No FedNow adapter or customer price is configured here. | (b) [Official source](https://www.frbservices.org/resources/financial-services/fednow-service-resources/fednow-service-operating-hours/), checked 2026-10-28. This rule does not establish a customer quote. |
| The Clearing House: public rule | RTP operates 24/7. Participation and customer pricing depend on the bank. No RTP adapter is configured here. | (b) [Official source](https://www.theclearinghouse.org/payment-systems/rtp/institution), checked 2026-10-28. This rule does not establish a customer quote. |
| Wise: public rule | Wise publishes use of the mid-market rate without a separate exchange-rate markup. Exact service fees require a corridor-specific quote. The generic bank model here is not Wise. | (b) [Official source](https://wise.com/us/pricing/send-money), checked 2026-10-28. This rule does not establish a customer quote. |
| Base: public rule | Base fees include execution, L1 data and operator costs. A gas price alone is not a full transfer quote. Mainnet telemetry is not Sepolia test-token pricing. | (b) [Official source](https://docs.base.org/specifications/transactions/network-fees), checked 2026-10-28. This rule does not establish a customer quote. |
| Base mainnet gas | Current execution gas price from eth_gasPrice; observed 0.0060 gwei during verification on 2026-10-28. Each visitor fetches a new reading. If the request fails, the UI says unavailable. | (a) [Base mainnet RPC](https://mainnet.base.org). Does not include gas units, L1 data, operator fees or ETH/USD. Not substituted for a full transfer price. |
| Same Day ACH cutoffs | 10:30, 14:45, 16:45 Eastern operator submission deadlines. | (b) [FedACH processing schedule](https://www.frbservices.org/resources/resource-centers/same-day-ach-resource-center/fedach-processing-schedule/), checked 2026-10-28. Customer bank cutoff remains an editable assumption. |
| Federal Reserve holidays | Published US banking calendar, including Thanksgiving 2026-11-26. Sunday holidays observed Monday; Saturday holidays do not close Friday. | (b) [Federal Reserve holidays](https://www.frbservices.org/about/holiday-schedules/), checked 2026-10-28. This corrects the playground calendar only; core adapter calendar is unchanged. |
| FedNow and RTP availability | 24/7, including weekends and holidays. | (b) Official links above. No FedNow or RTP adapter is added. |

## Derived numbers

| Number | Calculation / display | Class |
| --- | --- | --- |
| Principal in USD | Recipient minor units converted by the reference cross-rate; round up once to a whole cent using integer arithmetic. | (b) reference input; currency conversion is informational, not an executable price. |
| ACH fee | min(cap, fixed + ceiling(principal × variable rate)). Original: min($5, $0.25 + 0.10%). | (c), editable. No bank selected, so a network wholesale tariff cannot replace it. |
| Generic bank fees | Fixed + ceiling(principal × service rate), plus ceiling(principal × markup) for non-USD. Original: $0.50 + 0.05% service and 0.05% markup. | (c), editable. Renamed from Wise-style bank to avoid implying a Wise quote. Wise’s no-markup rule is documented separately. |
| USDC funding, network, exchange and payout | Funding percentage + network allowance + non-USD markup + bank payout fixed and variable fees when bank delivery is requested. Original: 0.05%, $0.02, 0.10%, $1 + 0.08%. | (c), each editable. No funding, conversion or payout provider selected. |
| Total fee | Sum of individually rounded fee line items, in cents. | (c), reconciled against steps and total by RouteQuoteSchema. |
| All-in cost | USD principal + fees. It is the total source debit, not just the fee. | (c) aggregate because fees are assumptions. |
| Cost range | Principal + external fees × (1 ± editable variation). Default 20%; internal ledger fee is exact within the model. All displayed USD costs round to cents. | (c). Illustrative sensitivity range, not observed market bounds or a price guarantee. Ranking and fee caps use the central estimate. |
| Arrival / latest arrival | Editable waits + bank window + US holiday rule. Internal ledger defaults to now, chain wait to 12 seconds, bank payout to 2 hours within working hours or next opening at 10:00 Eastern. Bank model defaults to 1 to 2 banking days. | (c) arrival estimates; the calendar rule is (b). Not Mexican holiday coverage and not a provider SLA. Display dates round up to the next minute. |
| Certainty percentages | Model scores from editable per-route values, displayed as whole percentages. | (c), uncalibrated, not measured success rates. |
| Timeline positions | Expected and latest arrival projected from selected send time to deadline. Dashed lines use editable customer cutoffs; shading uses bank hours and published US holidays. | (c) calculated positions, with (b) holiday input. |
| Scenario amounts, send times, deadlines, fee ceiling | Visitor-selected test inputs. Defaults: US $10, MXN 250,000, refund $25; max fees $100; ordinary deadline Nov 6 2026 23:00 UTC, holiday deadline Dec 5 2026 23:00 UTC. | (c), editable in the main form / advanced options. Scenario dates are examples, not today’s live clock. |
| Result count and assumption count | Counts of rendered rows / configured editable inputs. | Deterministic UI metadata, not financial claims. |

## Why some numbers remain assumptions

There is no selected bank, funding provider, payout provider or account-specific fee schedule. Published ACH, RTP and FedNow operator prices are not end-customer prices. Wise’s public pricing page does not establish an exact fee for this fictional generic provider. Base Sepolia test ETH has no market USD transfer price. Replacing any of these with a convenient published number would create a false quote. The UI labels and exposes them instead.

The mainnet RPC reading is live context only. The USD allowance remains an assumption because a complete transaction estimate needs gas used, serialized transaction size / L1 cost, operator cost and an ETH/USD conversion, and still would not price a Sepolia test transfer.

ECB rates are daily references, not provider quotes. Run `node scripts/check-playground-prices.mjs` to refresh the snapshot, then review the public rule sources before changing `checked` in the playground model. A failed live gas fetch never silently falls back to a value labelled live.

## Implementation boundary

Only the playground input adapter, UI, reference snapshot, refresh script, audit and additive tests change. The router, policy engine, production adapters, existing tests and execution boundaries are unchanged. No payment is executed.
