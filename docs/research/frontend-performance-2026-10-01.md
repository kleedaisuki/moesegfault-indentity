# Frontend performance investigation (2026-10-01)

## Scope, evidence, and limits

Investigated `apps/login`, `apps/account`, and `packages/frontend-shared` in the current
working tree. Consulted existing configuration/security/avatar-processing notes before
source inspection. The relevant user workflow is opening Login or Account, returning
between the two origins, navigating Account pages, and completing authentication.
An explicit latency SLO and representative authenticated production session were not
provided. Distinguish three issues: waiting for network/service work, waiting for
browser main-thread work, and visual smoothness during scrolling.

**Measured:** production-build byte sizes, the conflicting baseline Login cache header
in the real local Workers static asset runtime, corrected runtime headers/conditional
requests, and frontend test/build results. The lead investigator independently sampled
the same contradictory Login policy on production.

**Source-derived:** request dependency graph, preference listeners, and CSS/filter use.
No authenticated end-to-end timing or browser rendering measurement was collected.
Chrome DevTools MCP was unavailable, and an attempted isolated headless Chrome launch
was rejected by execution policy. No retry through another launch mechanism was made.
Do not describe this note as a Core Web Vitals audit, or infer LCP/INP/CLS from HTTP
timing, gzip sizes, or the presence of backdrop filters.

## 1. Confirmed cache defect and bounded correction

Baseline Login `_headers` defined `Cache-Control: no-store, no-transform` in `/*`
and `Cache-Control: public, max-age=31536000, immutable` in `/assets/*`.
The actual response for `/assets/index-BC7yChrU.js` was:

```text
no-store, no-transform, public, max-age=31536000, immutable
```

This is not a specificity-based override: Cloudflare joins duplicate header values
from matching rules. `no-store` prevents normal reuse despite the immutable declaration.
See [Workers Static Assets header rules](https://developers.cloudflare.com/workers/static-assets/headers/).
Account had no explicit long-lived bundle rule, so its default policy required a
freshness round trip (`public, max-age=0, must-revalidate`).

**Correction:** both applications now declare narrow `/assets/index-*.js` and
`/assets/index-*.css` rules, detach `Cache-Control` with `! Cache-Control`, then set
`public, max-age=31536000, immutable`. These names are content-hashed Vite entry
bundles. Login's HTML and unversioned `brand.svg` retain no-store. Account HTML and
unversioned icons retain the default revalidation policy. All original security
headers, CSP, cookie/CSRF handling, API no-store behavior, and JS output are unchanged.

The narrow match deliberately avoids freezing mutable `public/assets/brand.svg` or
`public/icons/*.svg` for one year. If future code splitting adds non-`index-*` chunks,
those chunks will conservatively retain revalidation/no-store until matching rules are
extended; do not widen the policy to mutable public filenames without versioning them.

| Local runtime path class | Corrected policy | Verified evidence |
| --- | --- | --- |
| Login `/`, `/login`, `/assets/brand.svg` | `no-store, no-transform` | 200 and explicit conditional 304 preserve policy and security headers |
| Account `/`, `/security`, `/icons/logo.svg`, `/icons/sprite.svg` | `public, max-age=0, must-revalidate` | 200 and explicit conditional 304 preserve policy and security headers |
| Login and Account hashed entry JS/CSS | `public, max-age=31536000, immutable` | All four bundles return exactly this value, with no inherited no-store |

The explicit conditional requests in the diagnostic demonstrate header behavior on
304; they do **not** imply an ordinary browser revalidates fresh immutable bundles.
No deployment was performed. Expected effect after deployment: remove repeated
bundle download/revalidation from an ordinary warm-cache return visit. This does not
improve the first cold visit, credential verification CPU, or private API latency.
Browser cache eviction, reload mode, and changed content hashes still cause requests.
No millisecond or percentage improvement is claimed without an actual warm-browser run.

## 2. Bundle baseline: not evidence of a large-JS application

Environment: Windows, Node `v26.8.2`, Vite `7.3.6`, pinned workspace dependencies;
Wrangler `4.131.1` for runtime checks. Commands:

```powershell
npm run build:login
npm run build:account
```

| Application | JS raw / gzip | CSS raw / gzip | HTML raw / gzip |
| --- | --- | --- | --- |
| Login | 56.85 / 20.20 kB | 11.97 / 3.57 kB | 1.11 / 0.63 kB |
| Account | 48.80 / 17.34 kB | 16.74 / 4.51 kB | 0.77 / 0.49 kB |

Numbers are Vite-reported decimal kB of build artifacts, not actual negotiated
production transfers. Source maps are separate (Login 189.15 kB, Account 153.72 kB)
and are not imported by the normal runtime. Before/after cache-only builds preserve
the same JS/CSS hashes and sizes. Neither application depends on a large UI framework;
the font declarations use local fallback stacks without a remote font fetch.
This reduces the plausibility of a large-JS boot bottleneck but does not prove that
rendering is fast on low-end phones.

## 3. Request critical path explains why small pages can still feel slow

Account `main.ts` first waits for both `getMe` and `getPreferences`, then calls
`renderPage`. The overview is immediate once bootstrap completes; a deep-linked
resource page waits for another wave:

```text
load HTML -> load entry JS/CSS -> bootstrap [GET /v1/me || GET /v1/me/preferences]
                                             |
                                             +-> overview renders
                                             +-> profile: GET contacts -> render
                                             +-> security: [GET security || GET authenticators] -> render
                                             +-> sessions: GET sessions -> render
                                             +-> apps: GET authorizations -> render
```

Assuming equal round-trip/service delay R for each GET, the source graph predicts
about R for overview bootstrap and about 2R for deep-linked resource readiness,
excluding static loading and rendering. This is an analytical prediction, not a
measured authenticated production latency. Subsequent navigation retains bootstrap
session state but deliberately rereads private resources. Every mutation refreshes
authoritative account/CSRF/preferences state before rerendering; never weaken that
behavior merely to improve a benchmark.

Login renders `/login` and `/register` without an initial API call. The first
credential action requires a browser-CSRF GET before its mutation POST; passkey
flows also require their ceremony start/completion and authenticator interaction.
GET clients set `Accept` without an unnecessary JSON `Content-Type` or CSRF header,
so the source does not induce unnecessary custom-header preflight for ordinary reads.
Mutation headers and resulting CORS preflights are security/protocol requirements.

**Decision:** do not speculatively start private route reads before bootstrap just to
flatten the graph. That increases authoritative reads for anonymous/expired sessions
and interacts with the global 401/abort transition. Do not replace required account
preferences with fake defaults. An authenticated trace can justify a narrow bootstrap
projection or route-aware loading design later, with security and compatibility tests.
For now, correct the demonstrated cache error and prioritize the measured backend and
network findings from the lead investigation.

## 4. Smoothness and secondary hypotheses

- Account uses blurred sticky sidebar/mobile navigation and translucent cards; Login
  uses card backdrop filters and a fixed masked background. These can be expensive
  on some GPUs, but no GPU/scroll trace proves they explain this user's experience.
  Both apps include reduced-transparency fallbacks. Preserve the visual design until
  a controlled on-device comparison identifies material frame-budget misses.
- Avatar decode/draw/encode uses native `createImageBitmap`, canvas, and (when available)
  `OffscreenCanvas`, but the canvas is not transferred to a dedicated Worker. This is
  a user-action-specific workload, not the default navigation path. An inexpensive
  next test is an on-device large-photo/anime-image corpus with input-to-preview time
  and long-task durations before choosing a Worker implementation.
- Account installs an additional media-query change listener each time its theme
  controls are rebuilt. This is a minor maintenance/leak hypothesis, not evidence of
  the broad service/page slowdown; avoid presenting it as the root cause.

Google's [INP optimization guidance](https://web.dev/articles/optimize-inp) distinguishes
input delay, processing, and next-paint delay; a visible loading indicator while an
API request is pending is not itself a main-thread responsiveness measurement.

## 5. Production practice and research implications

Cloudflare's documented detach/append mechanism directly determines the correct header
fix; narrow immutable naming preserves update semantics for mutable files. The pinned
local asset runtime confirmed the same behavior, so this decision is not based solely
on a homemade header parser.

[WProf (NSDI 2013)](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/wang_xiao)
provides the useful methodological distinction between activity size and work on the
dependency critical path. Here, a second private API wave can matter more than reducing
an already-small JS bundle. Its measurements on other websites are not estimates for
this application.

[Rethinking Web Caching (HotNets 2024)](https://conferences.sigcomm.org/hotnets/2024/papers/hotnets24-124.pdf)
explores avoiding validation round trips when latency dominates bandwidth. This is
relevant to Account's prior zero-max-age assets, but its proposed proactive validation
protocol is research, not a production dependency to adopt here. Existing content hashes
and immutable directives solve the immediate bounded problem without extra machinery.
No published speedup from that paper is transferred to this project.

## 6. Verification and reproducibility

Passed locally after the fix:

- `npm run test:login`: **13 files, 56 tests**.
- `npm run test:account`: **11 files, 50 tests**.
- `npm run lint:login` and `npm run lint:account`: **passed** using the normal CI
  commands (`tsc -b --pretty false`), including the new cache-policy regression files.
- Both builds above include TypeScript checking and passed with identical bundle hashes.
- New `apps/{login,account}/src/cache-headers.test.ts` lock the narrow immutable policy,
  inherited-header detachment, and HTML/unversioned-asset boundary. These are configuration
  regression assertions, not platform-runtime emulation.
- Real Wrangler asset runtime checks covered **11 paths** (all four entry bundles,
  HTML/deep links, mutable SVGs) with 200 and conditional 304 behavior plus preserved
  CSP, nosniff, and COOP headers. Current local diagnostic script/result:
  `.temp/frontend-cache-runtime.mjs` and `.temp/frontend-cache-runtime.json`.

Reproduce the platform check after builds, using separate terminals:

```powershell
npx wrangler dev --config wrangler.login.jsonc --local --ip 127.0.0.1 --port 43173 --inspector-port 0 --persist-to .cache/frontend-perf-wrangler --show-interactive-dev-session=false
npx wrangler dev --config wrangler.account.jsonc --local --ip 127.0.0.1 --port 43174 --inspector-port 0 --persist-to .cache/frontend-perf-account --show-interactive-dev-session=false
node .temp/frontend-cache-runtime.mjs
```

For a minimal check without the temporary diagnostic script, request each built
`/assets/index-*.js` and `.css` via `curl.exe -I http://127.0.0.1:43173/<path>`
(43174 for Account), compare `Cache-Control` to the table, and repeat with
`-H 'If-None-Match: <returned ETag>'`. Check CSP/COOP/nosniff are retained. The
temporary diagnostics and all runtime persistence stay inside repository `.temp`
and `.cache`; no experiment artifact was written outside the repository.

Release verification: after the normal deployment process, sample exact current
HTML-linked bundle URLs on both origins, then compare ordinary cold/warm browser
loads from the user's actual mainland-China network with a recorded proxy state.
Confirm assets come from browser cache on the warm visit and separately time private
API waves. Do not infer user geography from a server hostname or claim a fix is live
from these local checks.
