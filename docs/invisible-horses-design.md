# Invisible Horses

Black-and-white product redesign, 29 October 2026.

## Direction

Public brand: **Invisible Horses**. Product promise: **Let them run. Keep the reins.** The explanation stays concrete: give software agents a budget, set rules, approve exceptions and follow every payment request.

The user supplied a dashed horse illustration and requested a creative, natural.com-inspired black-and-white design. The live [Natural homepage](https://natural.com/) was reviewed for spacing, restraint and the separation of product explanation from interaction. Its content, claims and assets were not copied. The new horse artwork is an original generated dashed-line illustration inspired by the user's visual direction. A separate simplified horse-head SVG mark is used at small sizes.

## What changed

- Replaced the green visual identity with warm white `#faf9f6`, near-black `#191919` and neutral surfaces. Dark mode uses `#151515` with off-white text.
- Rebuilt the homepage around editorial typography and a galloping horse, followed by a request walkthrough, spending controls, intended users, API example, route planner and current product availability.
- Added four keyboard-accessible example steps, with text updates announced to assistive technology. They are explicitly illustrative and make no payment requests.
- Added a copy button for the API request with success/failure feedback.
- Added a monochrome wordmark, SVG favicon and horse-head brand mark across homepage, workspace and route planner.
- Updated public titles and copy to Invisible Horses. The GitHub repository, package names, API routes, credential prefixes, theme storage preference and existing URLs remain compatible.
- Applied monochrome tables, status labels, controls and metrics throughout the workspace and planner. Status remains readable as text without relying on color.
- Kept the homepage free of external fonts, heavy animation libraries, gradients, customer logos and invented metrics. The lossless WebP hero is approximately 138 KiB with transparency.
- Respected reduced motion. The horse only has a brief entrance when motion is allowed; there is no continuous movement.
- Preserved all pricing sources, assumptions and planning disclaimers. Illustrative homepage amounts explicitly use default demo rules and test credits.

The operational product remains an internal test-credit MVP. This design does not connect a bank or crypto provider. Route selection, policy enforcement, worker processing, authentication and payment contracts were not changed.

## Deployment

The existing production address remains [railgate-self.vercel.app](https://railgate-self.vercel.app/). No custom domain has been purchased or connected by this change.

## Validation

Typecheck, ESLint and 192 tests passed: 180 application tests and 12 routing/playground tests. Frontend builds passed. Browser verification covers desktop/mobile, light/dark, example interactions and the full workspace request/approval/background-processing flow.
