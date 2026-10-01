# PR19 combined Identity production rollout — 2026-10-01

## Verdict and evidence boundary

**PASS: exact main-source quality, immutable packaging, staged promotion, all six active Worker versions/binding pairing, and independent anonymous HTTP acceptance.** No required hosted gate or live metadata/HTTP check failed. No retry, manual supplementary deploy, rollback, provider setting/routing edit or credential operation was performed by the monitoring agent.

This verdict does **not** establish successful production password authentication for the original user, independently observed production OAuth resume navigation/terminal transaction state, or relying-party token persistence. The separate `401 authentication_failed / Authentication failed` rejection remains outside the resume correction's demonstrated boundary. No passwords, cookies, account/transaction records, authorization URLs/handles, codes, tokens, raw HTTP response bodies or user identifiers were collected, printed or persisted for this monitoring.

Root merged [PR #19](https://github.com/kleedaisuki/moesegfault-indentity/pull/19) at `2026-09-30T23:58:33Z` (2026-10-01 07:58:33 Asia/Singapore), triggering the repository's existing main-push quality → package → staging → production workflow. The monitoring agent did not independently merge, dispatch or deploy. Temporary cross-project provider-write hold had been explicitly lifted before root's merge.

## Exact source and immutable package

- Main release: `08576c0549c3ab8d6b8b90f0fb6591b59962f5dd`.
- Git tree: `9ec6aa2982efe2b7619db079665f331630441c39`, independently confirmed by GitHub commit API. This is exactly the reviewed candidate `6a2de04` tree and the earlier PR synthetic-merge tree.
- [Main-push run 36793808744](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36793808744): created `2026-09-30T23:58:36Z`, completed successfully by `2026-10-01T00:03:45Z` (08:03:45 Asia/Singapore).
- Release artifact: `release-08576c0549c3ab8d6b8b90f0fb6591b59962f5dd`, artifact ID `11132403993`, 1,024,822 bytes, non-expired at readback.
- GitHub artifact archive digest: `sha256:d9985b0ec44b584f47b38f7f65ad5d59eda12a52a99f310e7c09747ebe81d11a`. This identifies the GitHub archive, not the inner tarball checksum.
- Both staging and production logs independently report matching archive-download digest and `release-08576c....tar.gz: OK` from `sha256sum --check`. Both consume the same exact run artifact, rather than rebuilding at promotion.
- The production stale-main check succeeded; a subsequent independent `git ls-remote` confirmed main still at the release SHA.

This combined candidate includes issuer-rooted password OAuth resume, the already-verified staging performance mechanisms, and exact Wrangler `4.144.0` / undici `7.29.1` tooling repair. It preserves staging performance behavior rather than replacing it with the old narrow PR code. No schema/client/account/credential migration was required; both environment release logs report no migrations to apply.

## Hosted gate results

| Job | Job ID | Result | Completion UTC |
| --- | --- | --- | --- |
| Contracts, migrations, config, scripts | `110152520558` | SUCCESS | `00:00:07` |
| Account frontend | `110152520881` | SUCCESS | `2026-09-30 23:59:03` |
| Rust quality and Worker build | `110152520948` | SUCCESS | `00:01:03` |
| Login frontend | `110152521810` | SUCCESS | `2026-09-30 23:59:04` |
| Immutable deployment package | `110153174974` | SUCCESS | `00:02:22` |
| Required quality gate | `110153536037` | SUCCESS | `00:02:31` |
| Deploy and verify staging | `110153536499` | SUCCESS | `00:03:01` |
| Promote verified revision to production | `110153714745` | SUCCESS | `00:03:44` |

Unqualified completion times are 2026-10-01 UTC. The unchanged high-severity npm audit gate explicitly returned **0 vulnerabilities**. Rust/WASM, both frontend workspaces, contracts, migration/client generators, recovery/password policy and safe diagnostics checks passed. Packaging passed real Worker request-boundary/contact/password/session-budget harnesses and all deployment dry-runs. The password harness explicitly reported issuer-rooted OAuth resume plus stale proof denial, cookie rotation, prior-session/refresh-family revocation and secret replay refusal. These are hosted isolated runtime regressions, not live user credential evidence.

Staging smoke passed at `00:02:59.530Z`; only afterwards did production start at `00:03:04Z`. Production smoke passed at `00:03:42.119Z`. The workflow's existing automatic order and fresh-main condition were preserved; no production-only bypass was used.

## Independent live version / traffic readback

Fresh `wrangler deployments list` plus `versions view <active-id> --json` queries confirmed **one active version at 100% per unit**, matching the release SHA in both deployment and version source annotations:

| Environment | Unit | Active version | Deployment ID |
| --- | --- | --- | --- |
| Staging | Identity | `043b22bb-5792-47d6-9868-db9b888c2807` | `58748dd0-3dd0-424d-911c-c1dc84736355` |
| Staging | Login | `63b1ec90-de4f-4ea0-8569-19fdd84a28ec` | `32796e28-20d7-450b-ac0d-18d0635feaaf` |
| Staging | Account | `b4595e96-40b5-48ab-bc6c-48af008449be` | `d003015b-1dec-4491-b67a-6af445ba6c35` |
| Production | Identity | `5eb4a58e-46b1-4a38-a8f0-3b0f1cedac16` | `cba7dc35-7bb1-4c14-a736-a5e253d0b5ac` |
| Production | Login | `494214fa-68b5-4488-a96f-218be28f0447` | `427c3d42-40db-4618-9c19-f3ce29324a6a` |
| Production | Account | `1937fecf-ea35-4665-ba57-c4d54638a3fe` | `b445b4a0-3f91-4ec3-8d1f-78c9ed146ecc` |

Staging annotations are `Staging GitHub 08576c0549c3ab8d6b8b90f0fb6591b59962f5dd`; production annotations use `Production GitHub` and the same SHA. All versions retain compatibility date `2026-09-15`.

Version bindings were kept in memory and reduced to names/types plus explicit pairing assertions. Both Identity versions match their exact environment config for `ENVIRONMENT`, `ISSUER`, `LOGIN_ORIGIN`, `ACCOUNT_ORIGIN`, `AVATAR_PUBLIC_ORIGIN`, `OAUTH_ENABLED` and `WEBAUTHN_RP_ID`; `DB` database ID and both R2 bucket names match that environment, with no cross-issuer fallback. The `EMAIL` binding type and every secret **binding name/type** required by `release.sh` are present. No secret value is returned by these metadata fields or inspected. Login/Account versions have empty runtime binding lists and remain independent static frontends. Only allowlisted non-secret metadata was persisted.

Staging is the top-level Wrangler configuration; production is `--env production`. The monitor intentionally did not use nonexistent `--env staging`, alter environment config, query authenticated D1 rows or export deployed settings wholesale.

## Independent anonymous HTTP acceptance

Two bounded verification runs performed **19 requests per environment**, without credentials/cookies, redirect following, retries, response-body persistence or authenticated mutations:

- Staging: PASS at `2026-10-01T00:05:34.305Z`.
- Production: PASS at `2026-10-01T00:05:45.295Z` (08:05:45 Asia/Singapore).

| Contract | Both environments observed |
| --- | --- |
| Identity health | HTTP 200, `status=ok`, `checks.d1=ok` |
| OIDC discovery | HTTP 200, issuer equals the fixed paired environment Identity origin |
| Login root and `/login`, mutable brand SVG | 200; `no-store, no-transform` |
| Account root and `/security`, mutable logo/sprite SVGs | 200; `public, max-age=0, must-revalidate` |
| HTML-linked content-hashed JS/CSS | 200 and explicit conditional 304; exactly `public, max-age=31536000, immutable` |
| Frontend security headers | Original CSP, `nosniff` and same-origin COOP present, including conditional asset responses |
| Anonymous `/v1/me`, paired Account origin | Expected 401 `authentication_failed`; correct allow-origin and allow-credentials |
| Account-origin password PUT preflight | Expected 204; correct allow-origin and PUT allowance |

The anonymous `/v1/me` 401 is the correct unauthenticated API contract, not the original password failure reproducing. Conditional 304 probes establish header preservation; they are not a browser cache-hit timing measurement. Health version strings are not used as source identity; provider active-version metadata supplies source provenance.

## Artifacts, reproducibility and next boundary

Repository-local evidence is under `.temp/oauth-production-assessment-2026-10-01/`:

- `main-run-36793808744.json`, `main-artifacts-36793808744.json`.
- `main-{staging,production}-{identity,login,account}.json`, `main-deployment-verification.json`.
- `{staging,production}-main-http-verification.json` with allowlisted public headers/statuses only.
- `verify-main-deployments.ps1` and `verify-main-http.mjs`: explicit-source metadata/binding checks and bounded anonymous HTTP probes. The latter reuses the existing staging acceptance procedure with explicit environment selection; no project test/build runs locally.

The prior production versions, independently captured before release, are Identity `5e1f7831-4171-4e7b-97b9-924eed93201d`, Login `1037f74d-1e14-4758-881d-e006cfac8378`, Account `d4692428-a984-448e-997f-87efc026d001`. Existing rollback workflow requires an explicit root decision/reason; no rollback was needed. Returning to those versions restores the known password resume defect too. D1 rollback semantics remain separate, although this release applied no migration.

Remaining useful next observation is an authorized normal production password-OAuth journey, recording only environment/operation status and final relying-party outcome. Do not request passwords or infer which intentionally generic credential/identifier rejection caused the original user's 401. Keep its diagnostic issue separate until its own sanitized endpoint/status/problem/correlation evidence resolves it.

This report is deliberately documentation-only and was not pushed to main by the monitor, avoiding an unrequested second deployment merely to record release evidence.
