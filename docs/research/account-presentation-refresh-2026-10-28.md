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

## Completed in-app acceptance and compact command ownership

The Browser connection was subsequently repaired. Actual staging checks covered
the anonymous landing, light/dark appearance cycling, Chinese/English locale
selection, and navigation to Login and back with the paired staging return URI.
Tested preferences were restored. No account authentication, credential change,
profile save or production-account mutation is claimed by these display checks.

The actual shell/pages/CSS were also rendered in the in-app browser using the
explicitly synthetic local fixture. Overview and Profile were inspected, including
the real locale autonyms and a synthetic locale-save failure. This revealed a real
authenticated-shaped header problem: logout could become an orphan second row.
At360px viewport/345px available content, the old header measured113.7px and logout
started at y61.8 while the other controls started near y9.

[PR30](https://github.com/kleedaisuki/moesegfault-indentity/pull/30) groups preferences
and sign-out into one action region, while keeping sign-out outside the preference
host that is replaced during locale updates. Shared command locking is unchanged.
All narrow headers use a named logo target, avoiding session-specific layout
branches. The full localized home-link accessible name survives the compact visual
wordmark, and command/home targets remain at least44px.

Measured synthetic-fixture results at320px available content width:

| Element | Width / height |
| --- | --- |
| Header | Normal height67.2px |
| Home target | 44×44px |
| Language control | 109×46px; all three autonyms present |
| Theme control | 44×46px |
| Sign-out | 44×44px; remains in its action group |

The normal and locale-error cases had scrollWidth320 == clientWidth320. Error
feedback remains readable within its preference host; it is not hidden to force
the header to fit. The16 focused shell/presentation cases and production build
passed before hosted full suites. The temporary local Vite session was stopped
after acceptance; port5174 and its owned process were verified absent.

Two capture caveats were distinguished from product defects: a full-page capture
appeared cropped while DOM/viewport bounds were correct, and browser-scoped viewport
overrides apply to the selected tab rather than an arbitrary background tab handle.
Always confirm the measured inner/client widths on the target page. The deployed
staging header was finally checked in the selected tab at360px, with clientWidth345,
scrollWidth345, header height67.2px and the full Chinese accessible home-link name.
No speculative overflow-hiding or intrinsic-grid patch was shipped for the capture
artifact. Remote screenshot capture was intermittent, so the saved component
images, actual-page AX state and measured geometry are kept distinct evidence.
