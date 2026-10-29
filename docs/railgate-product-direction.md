# Railgate: one product, agent spending controls

Updated 29 October 2026.

## Product definition

Railgate gives software agents controlled access to payment requests. A company issues an agent key, sets spending rules, approves exceptions and follows the resulting work in an audit trail.

Public positioning: **Give agents a budget. Keep control of every payment.**

One product name: Railgate. The workspace is its operational interface. The route planner is its planning preview. Payroute remains an internal package and routing engine; it is not a separate public product. The route planner does not currently select the console's execution rail. The public console settles only in its internal test ledger.

## Who should use it

| Audience                              | Specific problem                                         | What they can do today                                  | What needs a provider integration                |
| ------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| Developers at AI startups             | An agent needs paid data or compute with spending limits | Integrate the API, test requests, budgets and approvals | Purchase real vendor services                    |
| Automation agencies                   | Client agents need separate credentials and boundaries   | Prototype isolated demo workspaces and agent policies   | Customer accounts, team access and real payments |
| Finance and operations at those teams | Agent requests need approval and a payment history       | Review requests and export audit records                | Reconcile actual provider transactions           |
| Individual developers                 | Learn or demonstrate agent payment controls              | Run the complete test-credit flow                       | Their real commercial payment use case           |

The initial buyer hypothesis is the founder or engineering lead of a small AI product team. Finance/operations is a collaborator. These are target customer hypotheses, not claims of existing customers or demonstrated demand. This is not positioned as a consumer transfer app, bank replacement or general expense platform.

## Is it worth building?

There is a coherent product opportunity around bounded agent spending. This MVP demonstrates the enforcement and execution flow, but does not validate that someone will pay for it. Generic payments and corporate spend are competitive; a UI redesign alone does not create differentiation.

The strongest initial proposal is: **one API for agents to request a specific kind of vendor payment, with company rules, human approval and a reliable record.** Start with one customer workflow and one provider instead of promising every bank, country or agent framework.

A useful first experiment:

1. Ask a few AI product teams how their agents obtain paid data or compute today. Look for an existing recurring task, not just interest in AI payments.
2. Have interested developers integrate a test key into one actual agent workflow. Observe where setup fails and whether approvals and records save work.
3. Choose one payment provider based on supported geography, permitted business model and the customer's vendor requirements. An arbitrary payout API does not automatically purchase a SaaS subscription or API credits.
4. Run a limited pilot after implementing the provider's authentication, request signing, idempotency, callbacks, reconciliation and failure handling. Match Railgate states to actual provider outcomes.
5. Decide pricing with pilot users after understanding who pays, transaction volume and provider costs. No invented subscription or transaction prices are published.

Proceed beyond a portfolio project when teams return to use it and can identify a concrete operational benefit. Compliments about the demo are weaker evidence than an integrated recurring workflow.

## Domain and services decision

**A domain is reasonable for a portfolio and customer conversations if the name is available and affordable.** Availability and trademark rights have not been checked. A domain does not make the payment integration production-ready. Do not buy an expensive premium name before customer validation.

**No additional backend purchase is needed to demonstrate the current MVP.** Vercel serves the web interface and gateway. A dedicated Cloudflare Worker with SQLite Durable Objects persists workspaces and runs independent background alarms. These are actual deployed services, subject to their current account limits and billing. Do not assume they are free at every usage level.

For a real company pilot, budget for the missing capabilities according to the chosen provider and customer:

| Capability                       | Current state                    | Next requirement                                                                               |
| -------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Hosting and background execution | Vercel + Cloudflare deployed     | Usage monitoring, alerts, backups and recovery drills                                          |
| Company accounts                 | Private seven-day browser access | Durable login, account recovery, team roles and invitations                                    |
| Agent credentials                | Scoped hashed test keys          | Production key lifecycle, usage controls and operating procedures                              |
| External payments                | Not connected                    | Approved provider account and one end-to-end integration                                       |
| Payment outcomes                 | Balanced internal demo ledger    | Verified provider events and reconciliation of pending, failed, reversed and settled states    |
| Customer operations              | Public demo limits               | Support process, retention policy and incident handling                                        |
| Business readiness               | Test-credit MVP                  | Provider eligibility and contractual/compliance review for the actual geography and funds flow |

Keep customer/provider secrets server-side. The public demo is not a place for customers to deposit money or paste production bank keys.

## Design direction and research

Reviewed the live public sites on 29 October 2026:

- [Ramp](https://ramp.com/): direct spending language, generous whitespace and clear primary actions.
- [Mercury](https://mercury.com/): restrained serif-led typography and a clear separation between the product promise and financial-service disclosures.
- [Linear](https://linear.app/): compact navigation, consistent product language and restrained dark surfaces. Its page text was accessible, but animated hero content was not fully visible in the automated first-frame screenshot.

- [Dealroom: startup stack behind AI spending](https://dealroom.co/resources/startup-stack-ai-spending/), supplied by the user: grouped market-map layout, clear category labels and restrained data presentation. The landscape includes wallets/spending controls, checkout, payment settlement and trust/risk. Railgate should start with agent spending controls instead of claiming all of these layers. The map is evidence of an active category, not proof of demand for Railgate.

- [Skyfire](https://skyfire.xyz/), an agent-payments company shown in the supplied landscape: visible request flow and clear product-layer navigation. Reviewed its live homepage; its identity/checkout offering is broader than Railgate’s current spending-control demo.

These are design references, not partners, endorsements or copied assets. No claim that the palette is objectively the most popular or best converting.

Railgate uses forest green `#146c4e`, a warm light background `#f6f7f4`, dark text `#172c25`, and dark-mode green-black `#101b17` with mint `#95d8b5`. Serif headings, system sans-serif body, native controls and local CSS keep it lightweight. The landing page, workspace and route planner share the same brand and palette. The homepage identifies example data, target users and the public demo's limits.

## Changes in this release

- Unified the public brand as Railgate and renamed the public playground to Route planner.
- Rebuilt the landing page around the product promise, real request flow, intended users, API, route planning and current availability.
- Added homepage light/dark switching using the existing shared theme preference.
- Applied a consistent green palette, brand mark, rounded controls, surfaces, navigation states and metric styling across the product.
- Kept routing, policy enforcement, API contracts and worker execution unchanged.
- Clarified that workspace **access** expires; the UI does not promise data deletion.
- Kept every illustrative transaction explicitly labelled. No customer logos, invented traction or live-money claims added.

The existing 51-second walkthrough records the previous visual styling. Its underlying test-credit flow remains accurate.

## Verification for this release

- Typecheck, ESLint, backend build and both frontend builds passed.
- 192 tests passed: 180 application tests and 12 routing/playground tests. No test expectations or routing logic changed.
- Browser verification covered all seven workspace views, workspace creation, issuing a key, a real API request, settlement after closing the only tab, replay without duplicate payment, owner approval, policy denial, audit export without the raw key, and isolation in another browser context.
- Landing page, workspace and route planner checked at desktop and mobile widths in light and dark modes. No document overflow or uncaught JavaScript errors observed.
- The local HTTP browser-check harness needed a browser fetch for the secure owner-cookie export check; production cookies and application code were unchanged.

## Production review

Source commit `e70beee` deployed successfully through the existing Vercel Git integration to [railgate-self.vercel.app](https://railgate-self.vercel.app/). The complete browser flow above was repeated against production, including settlement after closing the tab. The keyboard-operated theme switch and its persistence across homepage, planner and workspace also passed. No uncaught browser errors observed.

Production captures:

| Surface | Desktop light | Desktop dark | Mobile light | Mobile dark |
| --- | --- | --- | --- | --- |
| Product page | [View](railgate-product-screenshots/landing-desktop-light.png) | [View](railgate-product-screenshots/landing-desktop-dark.png) | [View](railgate-product-screenshots/landing-mobile-light.png) | [View](railgate-product-screenshots/landing-mobile-dark.png) |
| Workspace | [View](railgate-product-screenshots/desktop-light.png) | [View](railgate-product-screenshots/desktop-dark.png) | [View](railgate-product-screenshots/mobile-light.png) | [View](railgate-product-screenshots/mobile-dark.png) |
| Route planner | [View](railgate-product-screenshots/planner-desktop-light.png) | [View](railgate-product-screenshots/planner-desktop-dark.png) | [View](railgate-product-screenshots/planner-mobile-light.png) | [View](railgate-product-screenshots/planner-mobile-dark.png) |

Screenshots contain actual demo workspace records and no API key or session cookie. [Browser verification record](railgate-product-screenshots/verification.json).
