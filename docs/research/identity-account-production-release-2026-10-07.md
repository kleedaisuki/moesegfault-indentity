# Identity and Account production release — 2026-10-07

## Review

### Scope and conclusion

Independent bounded release-risk review of the journey working-tree changes,
the four changed Identity Rust modules, and the established delivery/rollback
contracts. No demonstrated source-level production blocker was found. This is
a conditional release recommendation, not evidence that a production deployment,
Cloudflare configuration check, or production smoke has happened.

The inspected checkout was `081bb05f6e96ea7de505c82632bd68037db101ac`, with
local `origin/main` at `dcbe33eaca9b676bb0beb954ec458a973be72f93`.
The release owner is isolating the reviewed journey diff onto main. That final
release tree and SHA must pass CI; local results on this checkout do not certify
a different merged tree. Include all owned new helpers and regression tests,
not only the tracked-file diff.

### Explicit exclusions

The two already-committed mskill OAuth registration changes (`7f1d4e1`,
`081bb05`) are unrelated to this journey release. Exclude their environment SQL
migrations `0012` through `0015` and other changes rather than implicitly
shipping the original branch ancestry. Also exclude the pre-existing unrelated
`docs/research/registration-production-delivery-2026-10-04.md`.
The journey working diff itself changes no migrations, Wrangler configuration,
delivery workflows, dependency manifests, or release/rollback scripts.

### Compatibility and authority assessment

| Area | Reviewed result | Release implication |
| --- | --- | --- |
| Profile read/write | Seven details fields are added to the self-service projection and strict PATCH model. Omission preserves, explicit null clears nullable text, and empty arrays clear lists. Unknown fields and invalid inputs still reject before writes. Existing display-name/locale behavior remains. | New Account needs the new backend; retain Identity → Login → Account deployment order. |
| Existing data | `account_profile_details` already exists in main's `0002_account_foundation.sql`. LEFT JOIN supplies defaults for missing legacy rows. Existing registration writers serialize interest arrays; new writes validate array contents. The PATCH uses one D1 batch for details, human profile, and principal timestamps. | No new schema migration or destructive data conversion is required. Do not restore a database snapshot during rollback. |
| Binding cookie | Successful renewals consistently retain the same binding for 600 seconds rather than shortening another live ceremony. Host-only/Secure/HttpOnly/SameSite and binding comparison remain intact. Transaction/proof SQL expiry is unchanged; expired requests do not renew. | This extends initial binding persistence, not mailbox-proof authority. Advertised CSRF refresh time is not a cryptographic token-expiry guarantee. |
| Credential management | First-key bootstrap still relies on the server's existing recent-password policy; recovery rotation does not gain a password-only bypass. Enrollment/rotation bind session reads, CSRF refresh, and assertion results to the original principal. | No new credential authority, RP ID, session format, OAuth grant, or identifier contract is introduced. |
| Client races and recovery | Shared Profile mutation ownership, partial-save settlement/baselines, locale approval snapshots, explicit read-only recovery, and abort/principal guards preserve drafts without automatic mutation replay. Sign-in cancellation applies only to the native assertion wait. | Local UI serialization is not a cross-tab server concurrency protocol or cross-endpoint atomicity claim. |
| Phone/password UX | Six existing country choices use shared explicit parsing; ambiguous `00` input rejects, legacy password login identifiers are unchanged. Password validation matches the existing backend. Unavailable SMS verification is disclosed instead of presented as a retryable service. | No new SMS transport, phone reachability guarantee, or password policy change. |

Detailed independent journey probes and resolved defects are recorded in
`user-journey-review-2026-10-07.md`. Real-Worker Profile readback, legacy defaults,
invalid-input no-change, and forced D1-batch rollback evidence are recorded in
`profile-readback-2026-10-07.md`; binding/expiry/security harness coverage is in
`scripts/tests/registration-email.mjs`. These are local evidence, not production
data inspection. Hardware Passkey acceptance remains explicitly deferred by
the user and is not, by itself, a blocker for these bounded repairs.

### Mandatory release gates retained

1. Use the reviewed final main SHA and the existing CI quality/package gates.
   `.github/workflows/ci.yml` permits production only from main push after
   staging, with protected-environment approval, checksum verification,
   stale-main rejection, and promotion of the same tested immutable bundle.
   A staging-only manual dispatch is not a production shortcut.
2. Verify that the isolated bundle contains no excluded mskill migrations.
   Check the environment-specific migration inventory and required secret names
   through the established release script; do not expose secret values.
3. Follow `scripts/release.sh` backend-first deployment. Record three known-good
   version IDs before release. If rollback is needed, restore Account and Login
   before Identity using the existing rollback workflow; never restore a D1
   snapshot, which could resurrect revoked credentials or grants.
4. Preserve `scripts/smoke.sh` checks: Identity deep health/D1, discovery,
   both frontend entrypoints, credentialed CORS preflight and anonymous 401.
   A successful static-page fetch alone is not the complete gate.
5. `infra/RUNBOOK.md` explicitly requires the release owner to verify the outer
   Cloudflare WAF rate-limit/challenge protection for
   `POST /v1/password/authentications`. Repository tests cannot prove that
   dashboard configuration exists; this review did not access or verify it.

### Checks performed for this release review

Read `infra/RUNBOOK.md`, CI promotion/package jobs, `scripts/release.sh`,
`scripts/rollback.sh`, rollback workflow, environment configuration, changed
Rust account/binding modules, and prior journey evidence. Independently checked
that main contains the existing Profile details table and that journey changes
do not modify release/migration/config/dependency files. Ran:

```powershell
fnm exec --using=24.18.0 -- node --test scripts/tests/delivery-workflow.mjs
```

Result: 4 tests passed, including no PR/manual production route and preserved
tested-package/staging dependencies. No production requests, Browser actions,
mail, credential operations, deployments, commits, or source edits were made
by this reviewer. Final CI, release approval, operational prerequisites, version
IDs, deployment results, and smoke outcomes belong in the release owner's
separate Release section below.

### Security dependency review — PR 26 follow-up

PR 26 CI run `37642648349` exposed a new release blocker in the existing audit
gate, not a reason to bypass it. Primary advisories identify patched versions
[sharp 0.35.5](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) and
[source-map-js 1.2.2](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
The former updates the bundled librsvg; the latter fixes excessive indexed-map
offset processing. No malicious-input exploitation was attempted in this review.

Reviewed the isolated worktree's minimal remedy: a `miniflare`-scoped exact
`sharp: 0.35.5` override and exact `source-map-js: 1.2.2` override. Wrangler
remains `4.144.0`, Miniflare remains `5.20260926.1-alpha`, and workerd is
unchanged. Do not use the audit tool's proposed ancient Wrangler downgrade.
The lock changes exactly 28 existing package records: sharp, its platform/native
libvips family, and source-map-js. No packages are added/removed; no authentication
source, frontend source, migration, Worker config, release workflow, or policy is
changed by this dependency repair. `git diff --check` passed.

Independent checks under Node `24.18.0` on Windows:

- `npm.cmd audit --audit-level=high`: **0 vulnerabilities**.
- `npm.cmd ls sharp source-map-js wrangler miniflare`: patched exact versions,
  scoped override active, Wrangler/Miniflare unchanged.
- Actual local Miniflare Images binding, not merely importing sharp:
  4×4 PNG `info` reports the correct dimensions; resize/output yields a decodable
  2×2 PNG; a benign SVG input also yields a decodable 2×2 PNG.
  Native versions are sharp `0.35.5`, librsvg `2.63.2`.
  Reproduction: isolated worktree `.temp/review-patched-images.mjs`.
- Ordinary and indexed source-map roundtrips match pre-update results. An initial
  indexed-column-zero expectation failed identically on old/new versions;
  this is not introduced by the repair. The corrected compatibility comparison
  passed. The first Images probe similarly assumed SVG rejection incorrectly;
  the Images binding supports SVG, unlike the separate `cf.image` local path.

The distinction matters for security: rejecting SVG after `sharp.metadata()` in
the separate local-fetch path would not prove SVG decoding unreachable. Updating
the vulnerable native library is preferable to claiming such an exemption.

**Review conclusion:** no concrete compatibility blocker found in the chosen
patched dependency approach. These dependencies are Node tooling/emulator
dependencies, not newly introduced production Worker runtime dependencies.
The repair leaves production application source unchanged; this is not a claim
that rebuilt artifacts are byte-identical. CI must rebuild and test the final
lock on its Linux runner, including Worker harnesses, frontend builds and
Wrangler production dry-runs, then promote that exact checksummed bundle.
Local Windows native-image success cannot certify Linux binaries. The previously
failed audit run remains failed until a new final-SHA CI run passes.

## Release

### Owner authorization and isolation

The owner explicitly authorized production rollout after the staging results and
the disclosed deferred credential/device journeys. The earlier staging-only boundary
is superseded for this release, not for arbitrary production testing. Root owns Git,
promotion and rollback; no production account, mailbox or credential mutation is
planned for acceptance.

Release branch codex/identity-account-journey-release starts at origin/main dcbe33e.
Its isolated checkout is repository-local .temp/identity-production-20261007/worktree.
Only the journey working diff and owned new source/tests are copied. The two
unrelated mskill commits, all four0012..0015 overlays, the original dirty checkout,
and the pre-existing registration-production-delivery-2026-10-04.md remain preserved
and excluded. No migration/config/dependency/delivery-policy change is part of this
release. The isolated production migration inventory is8common+2production and remote
Wrangler reports no migrations to apply; no remote migration command was executed.

### Pre-promotion gates and rollback baseline

Isolated-checkout frontend verification on supported Node24.18.0:
- shared6files/70tests, Login28files/234tests, Account26files/231tests passed;
- both TypeScript/Vite builds passed; entries match staging-accepted Login
  index-y4d-xBqN.js and Account index-BcRIcomX.js;
- final whitespace check passed.

The nested checkout cannot run the vendored Rust formatting discovery because
Cargo discovers the outer repository workspace. No manifest is changed to work
around this local-only layout. Root reran source-equivalent original-checkout
Rust fmt, workspace104unit+1doc tests and warning-free Clippy successfully. Hosted
CI on a normal checkout remains the authoritative final-SHA Wasm/contract/package
gate; no local result substitutes for that release gate.

Before rollout, direct production deployment metadata confirmed all three still
serve the known-good2026-10-05 release at100percent:

| Unit | Rollback version |
| --- | --- |
| Identity | ab243ca1-9a6b-4937-829a-900e642b1076 |
| Login | f241f26d-d624-4612-932b-ba7eb502f84e |
| Account | e9348f12-5723-4778-bc0b-8ac037efc5e2 |

Deployment metadata is saved in repository-local .temp/identity-production-20261007.
Rollback is code/assets only, Account/Login before Identity. No D1 restoration is
permitted and no secrets are copied into the release tree or notes.

### Existing operational posture

Root attempted a read-only production-zone http_ratelimit ruleset lookup using
the existing authenticated Cloudflare CLI credential, held only in process memory.
Zone lookup succeeded; the ruleset lookup returned403/error10000. Thus the outer
password WAF rule remains unverified, not known absent. No rule counts can be
inferred from that failed lookup. No permission, credential, WAF rule, authentication
throttle or other security setting was changed. This is a pre-existing operational
visibility limitation; this bounded rollout does not change the password-authentication
handler or weaken its existing account/unknown-identifier rate limits. Preserve the
unknown operational control as follow-up rather than claiming complete hardening.

The GitHub production environment readback currently has no protection rules; root
does not add, remove or bypass them. The existing main-only workflow, quality gate,
same-bundle staging promotion and stale-main check remain unchanged. Production is
not reported complete until the exact merged SHA workflow and production smoke pass.

### Publication and first hosted gate

The normal Git transport repeatedly returned server500 and then a TLS handshake
failure; certificate validation was never disabled. Root used the official GitHub
Git database API to publish each of the six reviewed local commits. Every remote
commit ID and every intermediate/final tree matched the local object exactly.
Only the release ref was fast-forwarded; main and its checks were not bypassed.
PR26 was created through the connected GitHub API after local GraphQL failures.

PR26 initial head f448f5d15af9df9fc8030cc10936e1be82b1ae2b hosted run37642648349
passed both frontend jobs and Rust quality/vendored/Wasm build. Contracts failed
the mandatory npm high-severity audit, so immutable packaging and all deployment
jobs correctly skipped. Root commissioned the bounded, reviewed dependency patch
below rather than skipping audit or accepting the suggested ancient Wrangler
downgrade. Production remained at the captured rollback versions throughout.

## Dependency remediation (PR 26 quality gate)

The first PR head f448f5d CI run37642648349 exposed two newly published high-severity
transitive advisories: sharp<0.35.5 (librsvg CVE-2026-96889,
https://github.com/advisories/GHSA-wq5f-xc86-pv6w) and source-map-js1.0.0..<1.2.2
(indexed-source-map denial of service, https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
Do not use npm audit fix --force: its proposed Wrangler4.15.2 downgrade is unrelated to
the intended supported runtime. Registry inspection found latest Wrangler4.148.0 still
uses Miniflare5.20261006.0-alpha with vulnerable sharp0.35.4; a general upgrade would not
solve this advisory and would expand scope.

Only the isolated release checkout package.json/package-lock.json were changed. Preserve
Wrangler4.144.0 and Miniflare5.20260926.1-alpha. Add exact scoped override
`miniflare: { sharp: "0.35.5" }` and exact source-map-js1.2.2 override. Existing sharp was
already0.35.4, so this is a patch release plus its matching native optional packages and
libvips1.3.3→1.3.4, not a new sharp minor. sharp0.35.5 requires Node>=20.9 and is compatible
with the project's Node24.18.0/npm11.16.0. The upstream patch changelog is
https://sharp.pixelplumbing.com/changelog/v0.35.5/; the advisory identifies bundled
librsvg2.63.2 as patched. Miniflare cf.image reads image metadata with sharp before SVG refusal,
so local SVG rejection is not treated as an advisory exemption.

Commands run only inside `.temp/identity-production-20261007/worktree`: package-lock-only
install with ignored scripts; explicit `npm update source-map-js --package-lock-only
--ignore-scripts` (the initial install retained its old locked node); clean `npm ci
--ignore-scripts`; `npm audit --audit-level=high` reports zero vulnerabilities. No root
node_modules/global dependencies/TLS settings are modified. Shared6files70tests,
Login28files234tests, Account26files231tests and both TypeScript/Vite builds passed.
Login index-y4d-xBqN.js and Account index-BcRIcomX.js remain the staging-accepted entries.

Parent authorized copying source-equivalent original-root ignored Worker build artifacts
into the isolated checkout solely for local compatibility tests; no .vars, secrets or
.wrangler state were copied. Harnesses each create isolated local D1 fixtures, without
remote operations. Contact full lifecycle and registration proof/profile roundtrip
harnesses have passed; remaining sequential harness results and independent Miniflare
Images-binding compatibility are recorded below when complete. The exact revised PR SHA
must still pass hosted CI; these local results do not replace that publication gate.


Sequential isolated compatibility results: contact verification lifecycle; registration
email proof/single-use/atomic profile roundtrip; password security (stale challenge403,
add/change204, issuer-rooted login resume, session/refresh-family revocation and replay
rejection); password rate-limit/stale-credential SQL policy/migration/constraints; recovery
authority SQL all passed. Independent reviewer exercised actual patched Miniflare Images
binding: PNG info4x4, PNG transform2x2 and successful ordinary SVG→PNG2x2, with
sharp0.35.5 and rsvg2.63.2. Its reproducible script is isolated-checkout
`.temp/review-patched-images.mjs`. The first probe incorrectly assumed all SVG paths reject
and its assertion failed; corrected probe passed (the cf.image path rejects SVG while
Images binding supports it). No image policy or production code was changed. Lockfile
review confirms only28 affected sharp-family/source-map-js records, no Wrangler/Miniflare
upgrade. Final security-boundary/OpenAPI gates follow below.

Final isolated gates also passed: actual Worker request security boundary (same-site/
missing-metadata malformed JSON400 with one claim; cross-site/foreign or absent Origin/
invalid or missing CSRF403 with zero claims), OpenAPI Redocly validation, shared TypeScript
check and git diff --check. Patched audit JSON is saved at isolated `.temp/npm-audit-patched.json`
with zero total/high vulnerabilities. Tracked isolated diff is exactly package.json and
package-lock.json; no application/backend/migration/configuration changes. Worker artifacts
used here were locally copied ignored source-equivalent builds, not a final-SHA hosted build.
Root owns committing/publishing the patch and exact revised-SHA hosted CI before rollout.
