# Payroute playground review

[Numbers audit and source table](payroute-numbers-audit.md)

## What changed

- Replaced the card grid with a comparison table showing every route, total source cost, expected and latest arrival, model certainty, and chosen / rejected reasons.
- Added a plain recommendation and a sentence explaining its selection. All-in means the principal plus fees; a separate line shows that breakdown.
- Matched faizan.sh's warm light palette, charcoal dark palette, muted blue accent, Times New Roman headings and Helvetica / Arial body. Uses three type sizes: 30px headings, 15px body, 13px small text. Only the recommendation uses a card border.
- Added a compact responsive form, advanced controls collapsed by default, and all six scenario buttons. Inputs update the plan immediately and the submit button remains available.
- Added a timeline from the selected send time to the deadline. Dots mark expected arrival, bars extend to latest arrival, dashed lines mark assumed customer cutoffs, and shaded bands show bank closures. Holidays are hatched. Screen reader labels give each route's actual times and eligibility.
- Added hover, click, keyboard and Escape support for provenance tags. Interactive source buttons sit outside form labels. Source links open official pages.
- Added 37 editable model / policy inputs with validation, reasons and a reset action. Changes recalculate before the existing routing engine evaluates eligibility and ranking. Scenario inputs remain editable in the primary form.
- Replaced fixed FX rates (17 MXN and 0.92 EUR per USD) with the ECB reference snapshot for 2026-10-28: 18.630737 MXN and 0.898230 EUR per USD. Visitor overrides are relabelled as assumptions.
- Added live Base mainnet execution gas context with retrieval time and an honest unavailable state. It is separate from the assumed full USD network allowance, since it is not a complete transaction price and the route models Sepolia test tokens.
- Added official FedACH submission windows, Federal Reserve holiday treatment, FedNow / RTP continuous availability and Wise's mid-market pricing rule as sourced context. These references do not silently become customer fee quotes.
- Renamed the fictional Wise-style route to generic Bank transfer. No Wise API or executable provider quote is configured.
- Corrected the playground's holiday treatment for Saturday holidays without changing the production adapter calendar. Bank windows, waits and payout timing remain explicit assumptions.
- Replaced false certainty claims with editable, uncalibrated model scores. Displayed dollar amounts round to cents; external fees show an editable sensitivity range. Rankings and policy limits still use the central estimate, with that distinction visible.
- Added the prices-last-checked line, the exact planning-tool disclaimer, the full in-page audit, and a reproducible ECB refresh script.
- Added four tests for default compatibility, exact cent reconciliation after edits, published holiday treatment and daylight saving / edited cutoff behavior. Existing tests are unchanged.

## Screenshots

Captured in Chromium at desktop 1440px and mobile 390px, using the Monday-night scenario, with all four combinations of size and theme:

| | Light | Dark |
| --- | --- | --- |
| Desktop | [Desktop light](payroute-screenshots/desktop-light.png) | [Desktop dark](payroute-screenshots/desktop-dark.png) |
| Mobile | [Mobile light](payroute-screenshots/mobile-light.png) | [Mobile dark](payroute-screenshots/mobile-dark.png) |

## Verification

- Root typecheck, lint, application build and staged playground production build passed.
- Root tests: 162 passed with the standard `pnpm test` command and original timeouts. Earlier cold runs hit the existing CLI startup timeout; the final standard run passed without changing that test.
- Payroute tests: all 12 passed, comprising 8 existing scenarios and 4 additive playground checks.
- Browser: all six scenarios, no eligible route / invalid input handling, assumption edits changing the winner, reset restoring the plan, source tag click / Escape, both themes and mobile layout verified. No page errors or page-level horizontal overflow.
- Monday night chooses USDC; Tuesday morning chooses Bank transfer. With the ECB reference defaults, the central all-in costs are $13,450.58 and $13,432.61 respectively for a 250,000 MXN recipient amount.
- Production JS is about 49 KB gzipped, with system fonts and no image or font downloads for the playground.

## Boundaries and limitations

The routing engine, production policy logic, production rail adapters, existing test files and payment execution remain unchanged. All changes to quote inputs and calendars are confined to the playground.

No bank, funding or payout provider is selected. Fees without an applicable public customer tariff remain assumptions. Cost ranges are sensitivity bounds, not measured market ranges or guarantees. The router uses central estimates. Arrival means recipient funds in the requested account type, not just chain confirmation. The US holiday calendar does not establish Mexican bank availability. FedNow and RTP are documented for context but are not additional routes. This page does not sign, approve or send payments.
