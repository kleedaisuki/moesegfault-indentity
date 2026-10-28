# Account presentation refresh — 2026-10-28

## Design decisions

This refresh keeps Account's existing first-party API, routing, draft ownership,
locale recovery, sign-out locks, and authentication boundaries unchanged.

- Use one page title, without repeating the brand above every heading. Overview
  shows the user's name once in its identity card; no placeholder biography is
  rendered when the user has not written one.
- Make overview cards concise route names with a directional affordance, not
  miniature explanatory panels. Their whole surface remains a real anchor.
- Focus the public landing on sign-in and registration. Retain one purpose
  sentence and three scannable capability names; remove extra eyebrow labels,
  repeated feature explanations, and decorative reassurance copy.
- Keep information that changes a decision: security readiness, form labels,
  verification instructions, failures/correlation IDs, and the separate Subscribe
  authentication boundary. Minimal copy must not imply shared credentials or hide
  consequences.
- Retain warm cream/cocoa and coral brand tokens, local SVG assets, and responsive
  sidebar/mobile navigation. Use solid card surfaces and softer shadows instead
  of per-card backdrop blur. The overview identity card receives a restrained
  warm gradient. Preserve reduced-motion, forced-color, and safe-area behavior.
- Use dark ink on pale coral primary controls in dark mode, and a readable pale
  green success badge foreground. Form fields and profile identity text can shrink
  or wrap instead of forcing horizontal layout expansion.
- Mark only actual navigation entries with `aria-current="page"`, on both
  responsive surfaces; brand/home links are not duplicate current-page markers.

## Practice references

- [W3C menu structure](https://www.w3.org/WAI/tutorials/menus/structure/): short,
  descriptive navigation labels and explicit current-page semantics.
- [W3C page structure](https://www.w3.org/WAI/tutorials/page-structure/): landmarks
  and meaningful headings provide orientation without duplicating visual copy.
- [GOV.UK question pages](https://design-system.service.gov.uk/patterns/question-pages/):
  add hints only when they help users answer; keep them short.
- [DWP hint text](https://design-system.dwp.gov.uk/guidance/hint-text): improve the
  question/interface first; generic service explanations are not field hints.
- Reused repository visual-system research:
  `docs/research/moesegfault-style-and-community-identity.md`.

## Verification

- `npm run typecheck:account`: passed.
- `npm run build:account`: passed; 29 modules, CSS 17.48 kB / gzip 4.64 kB,
  JavaScript 84.30 kB / gzip 27.74 kB after unused-CSS cleanup.
- `node node_modules/vitest/vitest.mjs run --root apps/account --maxWorkers=2 src/pages.test.ts src/presentation.test.ts src/ui/shell.test.ts src/ui/anonymous-landing.test.ts src/ui/subscriptions.test.ts`:
  5 files, 39 tests passed. Covers avatar confirmation and stale navigation,
  recent-authentication/network failure feedback, shell locale changes and
  sign-out locks, localized public entry, subscription boundary, and the new
  presentation/current-page invariants.

A disposable fixture in root `.temp/account-ui-preview.html` renders the actual
Account shell/pages with synthetic state; it is not an authenticated end-to-end
test or a deliverable. Local Vite was available at `http://127.0.0.1:5174`.
The supplied in-app browser could list its tab, but tab creation and navigation
both failed inside the browser integration with `Cannot read properties of
undefined (reading 'constraints')`. Documented troubleshooting did not expose a
usable alternative. No screenshot or responsive visual acceptance is claimed;
complete desktop/mobile and light/dark visual checks against staging when the
browser integration is usable. Existing API behavior remains covered by the
focused executable journeys above; CI owns broader regression execution.
