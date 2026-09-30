# Performance staging deployment — 2026-10-01

## Authorization, target, and source

The user requested deployment after the investigation proposed staging first. This release targets
**staging only**; production promotion and merging to main are not part of this authorization.
User-facing dates use Asia/Singapore. GitHub timestamps below are UTC.

Branch: `codex/performance-latency-20261001`.
Candidate source revision: `fa600038386ebe7e441fa79800a991f183d65577`.
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
