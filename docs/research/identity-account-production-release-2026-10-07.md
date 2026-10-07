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
