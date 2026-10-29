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

The production address is [railgate-self.vercel.app](https://invisiblehorses.vercel.app/). No custom domain has been purchased or connected by this change.

## Validation

Typecheck, ESLint and 192 tests passed: 180 application tests and 12 routing/playground tests. Frontend builds passed. Browser verification covers desktop/mobile, light/dark, example interactions and the full workspace request/approval/background-processing flow.

Additional browser checks passed at 320, 375, 768, 1024, 1280 and 1440 px with no document overflow. Keyboard activation of theme/example controls, theme persistence, clipboard copying and all brand asset responses passed. A tablet/desktop artwork overflow found at 1280 px was corrected before the final production review.

## Production review and screenshots

The implementation and viewport correction deployed successfully through the existing Vercel Git integration (`0a2f249`, `7540dcd`). Production browser checks passed for workspace creation, scoped key issuance, a real agent request, tab-closed settlement, idempotent replay, approval, denial, audit export and all seven workspace views. Homepage example steps, keyboard theme switching and cross-page theme persistence passed. No uncaught browser errors observed.

| Surface       | Desktop light                                                  | Desktop dark                                                  | Mobile light                                                  | Mobile dark                                                  |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Homepage      | [View](invisible-horses-screenshots/landing-desktop-light.png) | [View](invisible-horses-screenshots/landing-desktop-dark.png) | [View](invisible-horses-screenshots/landing-mobile-light.png) | [View](invisible-horses-screenshots/landing-mobile-dark.png) |
| Workspace     | [View](invisible-horses-screenshots/desktop-light.png)         | [View](invisible-horses-screenshots/desktop-dark.png)         | [View](invisible-horses-screenshots/mobile-light.png)         | [View](invisible-horses-screenshots/mobile-dark.png)         |
| Route planner | [View](invisible-horses-screenshots/planner-desktop-light.png) | [View](invisible-horses-screenshots/planner-desktop-dark.png) | [View](invisible-horses-screenshots/planner-mobile-light.png) | [View](invisible-horses-screenshots/planner-mobile-dark.png) |

[Production verification record](invisible-horses-screenshots/verification.json). Captures contain test-credit records, with no raw API key or session cookie.

The [51-second walkthrough](https://invisiblehorses.vercel.app/railgate-walkthrough.mp4) was re-recorded against the deployed Invisible Horses UI. It uses actual test-credit operations, updated monochrome captions and a masked private key. Export checked as H.264, 1280×720, 51.00 seconds, approximately 1 MB; complete video decode and key-mask frame review passed. The existing video URL is preserved for compatibility.

## Free domain migration

The verified production domain is now `invisiblehorses.vercel.app`, attached to the existing Vercel project. The console worker’s exact allowed origin was updated to match. The previous `railgate-self.vercel.app` address redirects to the new hostname. Demo owner cookies are scoped to their original hostname, so a visitor opening the new hostname starts a new browser workspace session; agent API key formats and storage remain unchanged. No domain purchase was made.

## Product screenshots and selective colour

Updated 29 October 2026, following the user's [Hermes reference](https://hermes-agent.nousresearch.com/). Its prominent real product view and distinctive illustration informed this change.

- Added a homepage workspace preview with Overview, Approvals and Activity tabs. Each image is a real production screenshot from a purpose-created Fieldwork Studio demo workspace, not a recreated dashboard.
- Made actual $12.50, $75.00 and $150.00 test-credit requests to record completed, approval-required and denied behavior. The screenshots expose no private API key or owner cookie.
- Captured desktop and mobile views in both themes. The preview selects the correct view, screen size and theme, with keyboard arrow/Home/End navigation and accessible tab/tabpanel relationships.
- Labelled the gallery as a production capture, not a live feed. The depicted $75 request was pending when captured; the image does not promise it remains pending now.
- Kept the neutral base. Added cobalt `#354dbe` to selected preview tabs, a small hero marker and hand-drawn-style horse annotations. A warm paper `#ede7d5` frames the product; the code sample uses a pale blue surface. Dark mode adapts these surfaces.
- Added a handwritten-style field note, a sparse hoof trail and a closing trail using local SVG/CSS. No heavy illustration or animation library added.
- All 12 captures use lossless WebP. Only the current responsive image is displayed; other screenshot tabs load when selected. Images are lazy-loaded with intrinsic dimensions.
- This release changes the homepage and public image assets. Workspace behavior, pricing data, routing logic and payment controls are unchanged.

Browser review passed at 320, 390, 768, 1024, 1280 and 1440 px, with all three views, both colour themes, responsive source selection, keyboard navigation, existing example controls and clipboard copying. No uncaught browser errors observed. Typecheck, ESLint and frontend build passed.

Regression suite: 192 tests passed (180 application, 12 routing/playground).
