# Performance staging deployment — 2026-10-01

## Authorization, target, and source

The user requested deployment after the investigation proposed staging first. This release targets
**staging only**; production promotion and merging to main are not part of this authorization.
User-facing dates use Asia/Singapore. GitHub timestamps below are UTC.

Branch: `codex/performance-latency-20261001`.
First candidate source revision: `fa600038386ebe7e441fa79800a991f183d65577` (blocked before deployment).
It builds on `32064c9`, the investigated current source; the earlier OAuth resume correction was
already deployed to staging at `5bf9cb4`. This release does not invent a separate deployment path.

Atomic commits:

- `ba88b0c`: frontend fingerprinted-bundle cache correction and regression assertions.
- `4cb5721`: primary session activity projection and skipped no-op D1 writes, with runtime harness.
- `236a7d1`: safe HTTP diagnostics and performance regression CI gates.
- `fa60003`: investigation, independent review, and validation evidence.

Prior local quality evidence is in the [investigation](performance-investigation-2026-10-01.md),
[frontend](frontend-performance-2026-10-01.md), [backend](backend-performance-2026-10-01.md),
[review](performance-review-2026-10-01.md), and [validation](performance-validation-2026-10-01.md)
reports. These checks are not themselves live deployment evidence.

## Release execution

Command:

```powershell
gh workflow run ci.yml --ref codex/performance-latency-20261001 -f delivery=staging-only
```

GitHub [run 36751251619](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36751251619)
was created at `2026-09-30T17:25:19Z`, with the exact candidate SHA above and event
`workflow_dispatch`. The workflow's explicit staging-only branch dispatch runs quality/package
jobs before `scripts/release.sh staging`; production runs only for main pushes.

The first run **failed before packaging or deployment**. Rust and both frontend jobs passed;
the dependency advisory gate failed on `npm audit --audit-level=high` in the contracts job.
The log reports the pinned `wrangler@4.131.1 -> miniflare -> undici` chain with 3 vulnerability
entries (2 moderate, 1 high), including undici advisories covering versions through 7.29.0.
Package, staging, and production were skipped. Neither remote environment was modified by this run.

Raw failure evidence: `.temp/performance-2026-10-01/staging-ci-failed.log` and
`npm-audit-before.json`. The repair must update the narrowly affected pinned tooling and lockfile,
not disable npm auditing, change the severity gate, or use `npm audit fix --force` indiscriminately.
Record the audited repair version and compatibility checks before redispatching staging-only.

### Narrow tooling repair

Selected exact `wrangler@4.144.0`, the first version outside npm's affected Wrangler range
(`4.102.0–4.143.0`), instead of an unconstrained latest upgrade or transitive override. Its
published dependency is `miniflare@5.20260926.1-alpha`, which pins patched `undici@7.29.1`.
Both 4.144.0 and the later 4.145.0 use patched undici; the smaller version step is sufficient.
Cloudflare's [4.144.0 release](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.144.0)
lists the Miniflare update; the [upstream advisory](https://github.com/advisories/GHSA-3wwx-pv8p-q78v)
identifies 7.29.1 as patched. The complete local audit covers all reported advisories, not just
the linked example. These are development/deployment dependencies; the shipped Rust/SPA source
is not changed by this repair, and no claim of an exploited production vulnerability is made.

Commands:

```powershell
npm install --save-dev --save-exact wrangler@4.144.0 --ignore-scripts
npm audit --audit-level=high
npm ls wrangler miniflare undici --all
npm run test:session-performance
npm run package:identity
npm run dry-run:login
npm run dry-run:account
```

The audit passed with **0 vulnerabilities**. Lockfile changes are limited to Wrangler and its
Cloudflare unenv/Miniflare/workerd/undici dependency chain; unrelated frontend versions remain
unchanged. The imported Miniflare V4-option conversion API remains available. The real release
Wasm session harness passed against the repaired emulator. All three dry-run packages passed;
`--env production` here is the existing **dry-run validation**, not a production deployment.
Real local asset-runtime checks were repeated specifically because the serving emulator changed:
all 11 paths passed with correct 200/304 cache and security headers on Wrangler 4.144.0.
Repair artifacts are under `.temp/performance-2026-10-01/`, including
`frontend-cache-wrangler-4.144.json` and `session-worker-xm4li0/results.json`.

### Repaired candidate

Toolchain repair commit: `7294f81`; release evidence commit: `9409202`.
Second source revision: `9409202d890bdcd52fe458e6c10a4815efad23eb`.
GitHub [run 36752376608](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36752376608)
was dispatched with the same `delivery=staging-only` input. This is a new audited candidate,
not a rerun that pretends the failed revision was deployable. It is the actual deployed revision.

Before this run's deployment, an independent local read-only `wrangler deployments list` query
confirmed Identity staging was still 100% on version `a196b5df-e0af-442d-b7f7-f266748bceed`, with
message `Staging GitHub 5bf9cb4a43d3122fe9f3ae8df363c5a12158cc67`. This provides a pre-release
rollback reference and corroborates that the failed candidate did not deploy. Readback contains
only version/deployment metadata, not secrets or account/session contents.

Pre-release version readbacks (each at 100%):

| Unit | Staging rollback version | Production version to remain unchanged |
| --- | --- | --- |
| Identity | `a196b5df-e0af-442d-b7f7-f266748bceed` | `5e1f7831-4171-4e7b-97b9-924eed93201d` |
| Login | `43146c76-4fdb-492d-a536-26a724936cbd` | `1037f74d-1e14-4758-881d-e006cfac8378` |
| Account | `9edf51c1-47ef-4e17-bce3-5ce9b5a77555` | `d4692428-a984-448e-997f-87efc026d001` |

All three staging versions were annotated with source `5bf9cb4a43d3122fe9f3ae8df363c5a12158cc67`;
production versions were annotated with source `a50482b27541e37c909557d0f3b994544115d2b4`.

## Final outcome: staging deployed and independently verified

Run `36752376608` completed with **success**. Rust, both frontends, contracts, immutable packaging,
and the required quality gate passed. The package job exercised browser boundary, contact
verification, password authority/rotation, and the newly added real-Worker session RPC budget.
The staging job verified `release-9409202d890bdcd52fe458e6c10a4815efad23eb.tar.gz: OK`, used
Wrangler 4.144.0, materialized the reviewed 6 common + 1 staging migration stream, and reported
**no migrations to apply**. It deployed Identity first, then Login and Account, and finished live
smoke successfully at `2026-09-30T17:38:36Z` (2026-10-01 01:38:36 Asia/Singapore).

[Staging deployment job 110015294306](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36752376608/job/110015294306)
is the release-log evidence. Production promotion was **skipped** by the workflow condition.

Independent read-only deployment metadata queries confirmed all three staging versions at
**100% traffic**, each annotated `Staging GitHub 9409202d890bdcd52fe458e6c10a4815efad23eb`:

| Unit | Active version ID | Deployment ID |
| --- | --- | --- |
| Identity | `7368a0df-94a8-42f8-aa8d-83ff59aa732d` | `f0dcc3ca-b807-4051-9bbf-691a1dc99a49` |
| Login | `704c8b9f-fa73-4c3f-9c62-82f366fedeb7` | `b4e0ef47-8859-4b6f-b3e5-23027474e715` |
| Account | `2aa02762-ef67-4787-95fd-de85f911b9b5` | `6a1d14aa-4884-4c04-98b6-b3eedbefef00` |

The asset-only deployments still printed `No targets deployed`; that line alone is not treated
as failure or success. New active version metadata and independently corrected public headers
establish that the releases are live. JS/CSS content hashes intentionally did not change.

### Independent public HTTP verification

`.temp/performance-2026-10-01/verify-staging.mjs` made **19 bounded, anonymous requests** with
curl explicit-proxy bypass; it supplied no session cookies, credentials, or authenticated mutations.
It exited 0 with verdict **PASS** at `2026-09-30T17:40:02.617Z`.

| Contract | Observed |
| --- | --- |
| Login `/`, `/login`, mutable `/assets/brand.svg` | 200; `no-store, no-transform` |
| Account `/`, `/security`, mutable logo/sprite SVGs | 200; `public, max-age=0, must-revalidate` |
| Four HTML-linked hashed JS/CSS bundles | 200 and explicit conditional 304; exactly `public, max-age=31536000, immutable`, without inherited `no-store` |
| All frontend responses above | Original CSP, nosniff and COOP present |
| Identity `/healthz` | 200; `status=ok`, `checks.d1=ok` |
| OIDC discovery | 200; staging Identity issuer |
| Anonymous `/v1/me`, Account origin | 401 `authentication_failed`; correct allow-origin and allow-credentials |
| Account-origin PUT preflight | 204; correct allow-origin and PUT allowance |

The bundle names remain Login `index-BC7yChrU.js`/`index-1ICyddhu.css` and Account
`index-Deq0DLZ8.js`/`index-CBW-GHHn.css`. For reproducibility, request the assets linked by current
staging HTML, inspect the header policies above, then send their returned ETags with
`If-None-Match`. The explicit 304 checks validate header preservation, not ordinary warm-browser
cache hits. Sanitized public headers/statuses are saved in `staging-http-verification.json`.

### Production protection confirmed

All three production deployments were independently read again after staging rollout and compared
to the pre-release snapshots. **Deployment IDs and version/traffic allocations are unchanged**:

- Identity deployment `4e9ae15f-8114-498b-b06f-7f91fc83830f`.
- Login deployment `56523208-2ba4-420c-a50a-a6a48d9410e5`.
- Account deployment `00efdec7-46aa-48c7-a3dc-c64a0adab78d`.

Their active versions remain those in the pre-release table. This corroborates the skipped
production job; there was no main merge or production promotion.

### Evidence artifacts and remaining boundaries

Local artifacts: `staging-deploy.log`, `staging-repaired-run-watch.log`,
`staging-http-verification.json`, and `{staging,production}-{identity,login,account}-{before,after}.json`
under `.temp/performance-2026-10-01/`. Deployment snapshots are metadata, not secret-value exports.
Temporary local Wrangler servers used for repaired-tool compatibility checks were stopped.

Staging rollout and its anonymous contracts are complete. The backend optimization is verified
against real local release-Wasm/D1 and the deployed source is independently identified; this does
not establish an authenticated deployed before/after latency percentile or browser frame-rate
improvement. No new logged-in user journey, inbox delivery, browser cache-hit trace, or mainland
China device/network trace was performed. Production deployment remains a separate decision.

## Required post-release checks and limits

- Confirm the run completed successfully and production promotion was skipped.
- Record the deployment log's Identity/Login/Account version IDs and release-source annotations.
- Independently request staging health, OIDC discovery, both frontend roots and current HTML-linked
  JS/CSS; fingerprinted bundles must return only `public, max-age=31536000, immutable`.
- Preserve HTML and mutable SVG policies; inspect CSP/nosniff/COOP and conditionally served assets.
- Confirm anonymous `/v1/me` is still 401 with the allowed Account-origin credentialed CORS policy.
- Do not interpret a shared `version=0.1.0` health field as a unique Worker build identifier.
- Do not claim logged-in production speedup, browser cache hit behavior, user-device smoothness,
  real mailbox delivery, or authenticated end-to-end OAuth validation from anonymous smoke checks.

All downloaded logs and probe artifacts stay under repository `.temp` or `.cache`. Runtime secrets,
cookies, credentials, transaction handles and authorization codes are excluded from this report.
