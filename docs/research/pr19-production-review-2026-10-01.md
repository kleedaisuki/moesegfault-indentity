# Independent PR19 production-source review — 2026-10-01

## Identity, scope, and verdict

Reviewed committed candidate **`0eb33e2bedc3d98dc6aab733f3c16e5c6b259ccc`**, tree **`90119b8a23aa5a653d79a53eb1a82999b92f1e20`**, in the isolated `identity-pr19-production-20261001` worktree. Baseline: `56a501eb9de1c880fe93f44af7ad10e7586c0b41` (main snapshot). PR19 head: `32064c9446b5cc809afc0068f0016b5f14155fb0`. Candidate adds the exact narrow tooling repair cherry-picked from `7294f818f64ff2f4f9213fa0ae8e963b093fd461`; candidate versus PR19 changes only `package.json` and `package-lock.json`. Parent-owned uncommitted assessment/Skill updates are outside this committed-source verdict.

**Source GO:** no substantive change-induced correctness or backward-compatibility defect was found in the reviewed resume fix or dependency-pin patch. **Immediate production promotion NO-GO until fresh revision-bound release evidence exists:** old PR19 green CI and current staging deployment are not candidate CI. This is a release-evidence constraint, not a demonstrated bug in the candidate.

No production code was modified. No build, project test, dependency installation/audit, authentication attempt, credential inspection, remote mutation, push, or deployment was performed by this reviewer. Git inspection, selected documentation reads, source tracing, and public standards/vendor/advisory retrieval support this review. This is not a whole-system security audit or proof of runtime behavior.

## Resume paths and compatibility

| Path | Baseline behavior | Candidate behavior | Evidence / assessment |
| --- | --- | --- | --- |
| Password completion | Root-relative `/v1/oauth/.../resume` | Fixed configured issuer + same route/id | `password.rs:620–654`, especially 643; corrects the deterministic cross-origin error. |
| Passkey completion | Absolute configured issuer URL | Same URL via common helper | `api.rs:1135–1141`; removed local issuer implementation has equivalent fallback behavior. |
| Existing authenticated authorization | Absolute configured issuer URL | Same URL via common helper | `oauth.rs:243–244`; redirect destination remains equivalent. |
| Login navigation | `new URL(value, location.href)` then top-level `location.assign` | Unchanged | `apps/login/src/pages.ts:298–307,325`; existing frontend accepts the new absolute response without a paired frontend release requirement. |

`oauth.rs:1355–1366` constructs the destination from deployment-owned `ISSUER`, not request Origin, Login location, or a supplied redirect URL. Staging and production configuration explicitly provide their paired HTTPS issuers (`wrangler.identity.jsonc:11,72`). The change does not alter credentials, cookies, CSRF, session creation, authorization-code issuance, transaction binding, scope checks, expiry, registered redirects, or D1 schema. The resume handler retains matching principal/session, authenticated state and expiry checks and consumes the transaction before callback (`oauth.rs`, `resume`).

Password JSON changes from relative to absolute, but the published response already declared `format: uri` and an absolute production URL. This restores the promised contract instead of changing a supported relative-URI contract. Inspected first-party callers do not rely on the broken relative form; external callers relying on undocumented string concatenation are not evidenced. Passkey and existing-session wire destinations remain unchanged. Responses without an authorization transaction continue to omit the optional field. Login still prioritizes OAuth resume over an Account return URI.

OpenAPI `identity.yaml:1946–1952` removes the production-only hostname pattern and documents the configured issuer invariant. This allows staging without redefining authority: it broadens schema validation, not server redirect selection. Keeping an environment-specific production regex would contradict staging's real contract.

### Tests: useful evidence, explicit limits

The added real-Worker password regression seeds synthetic local state, obtains the real browser context, invokes the actual password route, checks the staging absolute URI and `authenticated` transaction state (`scripts/tests/password-security.mjs:120–139`). It would distinguish the former relative-response bug. The Rust helper test covers both fixed production and staging issuers (`oauth.rs:1496+`), though helper-only testing does not establish browser navigation or full route lifecycle.

Neither added test alone observes a native callback or final `completed` transaction. Existing documented staging native-login success is valuable end-to-end evidence, but the incident report explicitly leaves separate browser-origin and D1 terminal-state readbacks unobserved. Those narrower closure checks should not be falsely reported as executed or mistaken for demonstrated blockers to the minimal source correction. The contact harness's `connection: close` applies only to synthetic test requests; no runtime HTTP policy is changed.

## Authentication failure is not resume failure

At `password.rs:291–424`, the generic **401 `authentication_failed` / “Authentication failed”** is returned before constructing the success response: overlength password, unresolved/unusable identity or failed verification, inactive principal, and a credential/session race invalidating the verified snapshot can reach this outcome. Unknown identifiers, unverified contact identifiers and missing password credentials intentionally do not disclose which condition failed. Rate limiting is separately 429; invalid authorization transaction is separately 400.

A **200 successful password response followed by navigation to the wrong Login origin**, with an authorization transaction remaining `authenticated`, is the PR19 incident boundary. Changing `authorization_resume_uri` cannot repair a 401 because that field is only created on the success path. Do not infer an actual user's wrong password, wrong account, identifier-verification status or account lifecycle from a generic failure; collect only status, stable problem code, environment/origin pairing and redacted correlation metadata with authorization. Never collect or publish passwords, cookies, codes, tokens or opaque transaction handles to establish this distinction.

## Tooling release readiness

`package.json` and the lockfile root consistently pin Wrangler **4.144.0**. The locked chain is Wrangler → Miniflare **5.20260926.1-alpha** → undici **7.29.1**, with workerd **1.20260926.1** and paired platform packages. The lockfile patch is byte-equivalent as a Git diff to the original tooling repair (both diff hashes: `53b5f7be77cccce8e04c5caf23cda5049e4143b1`). The source context of `package.json` differs because the broader performance branch has additional scripts; the applied version edit is the same. No unrelated frontend dependency upgrade or audit bypass appears in this candidate.

The existing performance deployment report (`D:/Code/moesegfault-indentity/docs/research/deployment-performance-2026-10-01.md`) records a current CI failure of the old Wrangler chain, successful zero-vulnerability audit after repair, emulator compatibility checks and three deploy dry-runs on the **different performance branch**. This is corroborating evidence for selecting the patch, not proof that this candidate passed those checks. Its failed run is [36751251619](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36751251619).

Cloudflare's [Wrangler 4.144.0 release](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.144.0) confirms the Miniflare update. The [upstream advisory GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) identifies undici 7.29.0 as affected and 7.29.1 as patched for that advisory. This single advisory does **not** prove a complete current zero-vulnerability audit. These dependencies are development/deployment tooling; their presence does not establish exploitation of the Rust Worker or SPA.

### Prioritized release constraints, not code findings

1. **Required, high confidence:** obtain current quality/contracts/audit/package results for the exact published candidate or final merge SHA. `.github/workflows/ci.yml:124–127` retains `npm audit --audit-level=high`; do not weaken it to revive an old green run. CI packages only after all quality jobs and runs the password real-Worker harness and all three production-config dry-runs (`144–183`). Rebuilding under the patched emulator is precisely why the original PR green state cannot be inherited.
2. **Required, high confidence:** promote the immutable bundle generated for the final reviewed main revision through the normal staged pipeline. Production job only runs for main pushes after staging, verifies checksums and rejects a stale main SHA (`ci.yml:229–256`). A deployment at staging revision `9409202` contains additional performance changes and is not the isolated PR19 candidate. Do not promote those extra changes under this review's approval.
3. **Operational boundary:** any production/main mutation requires the authorized owner decision; this source review grants no execution permission. Preserve environment pairing and use rollback to the prior reviewed release if production behavior regresses, while acknowledging that rolling back also restores the known password resume bug.

## External grounding and confidence

The URL diagnosis follows [RFC 3986, reference resolution](https://datatracker.ietf.org/doc/html/rfc3986#section-5.2): a root-relative reference retains the base authority, while an absolute URI supplies its own authority. The [Cloudflare production best-practices reference](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) was consulted; no platform API or binding contract changes are introduced in this patch. This is a standards-defined URI boundary and revision-provenance review; a new academic method would not replace these executable contracts or close the missing CI evidence.

Confidence is high in deterministic resume correction and inspected caller compatibility; moderate in complete release readiness until current candidate/merge CI and rollout evidence exist. No substantive source finding is asserted. Unexamined authentication, session, persistence and deployment behavior is not certified by the absence of findings.

## Concurrent worktree evolution / documentation follow-up

During this review, the parent committed assessment/Skill documentation at `b8d606c74b7f6b305333379541802d5ca698c932` (tree `1da912509d714c2e6940fe60e8693686a66de8c8`) and then merged staging performance history at `8c72fac7ccf08da21703ac93f77a706abf84fae5` (observed tree `e0b10bd9f1bb4e88ef798d9d72741a28a6e86213`). The source GO above applies to **0eb33e2**, not this enlarged merged source. Review of the parent assessment found its separation of 401 versus resume, historical versus exact-candidate CI, and automatic production-on-main-push consequences sound for the original narrow candidate.

The merged candidate requires a scope update: the assessment's exclusion of performance changes, intentional staging performance rollback, and narrow release description no longer describe the merged tree. Correct those passages and connect the merged candidate to its separately owned performance review/validation evidence; do not silently extend this review's approval. The parent has been notified. This is a consequential provenance/documentation constraint, not an alleged performance implementation defect.

Parent-supplied allowlisted audit metadata identifies the old chain as 0 critical, 1 high, 2 moderate vulnerable dependency entries; the undici entry contains ten underlying advisories, including high `GHSA-rfgv-xxqx-mfg5` and `GHSA-w293-vg96-wgc3` affected below 7.29.1. The moderate example advisory cited above is not the sole high release blocker. Hosted repaired performance success [36752376608](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36752376608) is at `9409202`, not either isolated candidate SHA. This additional metadata is attributed to the parent inspection, not an audit rerun by this reviewer.

## Bounded follow-up: full combined candidate — final source verdict

At the root's explicit request, extended the independent review to committed **`68f95889552d9859267d10dd628698748e32cce1`**, tree **`9b20b15a49cd361bd206ca1651c5845fc025abc7`**. This supersedes the earlier scope limitation for the performance merge: **full combined candidate source GO**, with no substantive defect found in the inspected OAuth repair, session-activity projection, asset cache policy, diagnostic tooling, test/CI wiring, dependency repair and revised runbook. **Immediate production promotion remains NO-GO until the exact final published/merged revision passes the existing current hosted gates and release authorization is obtained.** Source approval is not deployment execution approval or a promise to fix the user's 401.

### Exact merge equality

Independent `git diff 9409202 HEAD --name-only` lists only:

- `docs/research/pr19-production-assessment-2026-10-01.md`
- `skills/moesegfault-identity/references/first-party-clients.md`

The complete diff is 73 documentation lines. A separately scoped diff across `.github`, `apps`, `crates`, `infra`, `migrations`, `openapi`, `packages`, `scripts`, package manifests/lockfile and Wrangler configurations is empty. Therefore application/runtime/configuration/dependencies/tests/workflow source is byte-identical to staging source **`9409202d890bdcd52fe458e6c10a4815efad23eb`**. This is independently verified Git-tree equality, not a claim that rebuilt artifacts, current live traffic versions, or a new SHA's CI are identical. The reviewer report itself is uncommitted at this check; later documentation-only commits can preserve the same runtime equality but must receive their own final recorded SHA.

### Material performance mechanisms checked

Reused the now-present `performance-review-2026-10-01.md`, `performance-validation-2026-10-01.md`, backend/frontend investigation and deployment report. Independently inspected the mechanisms rather than accepting conclusions alone:

1. **Data ownership / authority:** `repository.rs:45–66,585–607` and `account_repository.rs:409–431` add `last_seen_at` to the existing primary-first authoritative session SELECT, deserialize an internal `SessionActivity<T>`, then return the original public projection. Principal-active, revocation, idle-expiry and absolute-expiry predicates remain unchanged. The field does not become API state or a client-controlled authority cache.
2. **No-op elimination:** only sessions younger than the existing 300-second renewal threshold skip the old conditional UPDATE. For ordinary Unix-second timestamps, Rust `last_seen_at <= now.saturating_sub(300)` matches the SQL threshold. Due renewals remain awaited; `touch_session` still checks revocation and expiry and clamps idle expiry to absolute expiry. No background renewal, extended stale read, relaxed session proof, schema migration or principal-policy change is introduced. Concurrent activity after the SELECT can make the remaining SQL no-op as before; concurrent revocation remains an existing read/use issue, not a new cache bypass.
3. **Cache compatibility:** both frontend `_headers` files change only the cache rules to `/assets/index-*.js` and `.css`; broad CSP, COOP and other security headers stay intact. Login HTML/unhashed assets retain `no-store, no-transform`; Account's unchanged broad policy is not replaced with immutable caching. The removal directive precedes the new immutable value, avoiding contradictory inherited Cache-Control. Vite's content-hashed filenames are the intended invariant; HTML remains capable of referencing a fresh bundle after deploy. The prior overly broad Login SVG rule is removed. No new claim of faster cold first visits is warranted.
4. **Regression contract:** the real release-Wasm harness checks actual D1-call counts and HTTP decoding, fresh/due Account and generic session lookup, inactive/revoked/expired sessions and absolute-expiry clamping. The concurrency case is not a deterministic interleaving proof; unchanged guarded SQL supports the concurrency argument. The inherited validator independently exercised password/cookie/revocation and request-boundary behavior. Its original Wrangler 4.131.1 environment must not be misrepresented as a patched-tooling rerun; the deployment report separately records subsequent 4.144.0 compatibility checks.
5. **CI/diagnostics:** new contract diagnostics and session-budget gates are wired into contracts/package after the tested Wasm artifact restore. The diagnostic CLI inspects fixed anonymous GET endpoints with bounded time/body/sample limits, curl config loading disabled, no redirects/credentials and allowlisted response metadata. It does not change production request behavior or establish authenticated latency. No production security parameter is reduced to pursue performance.

Platform semantics were checked against [Cloudflare D1 sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [Workers Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/). Existing research references in the performance review appropriately motivate serialized-work and end-to-end measurement; they do not supply a transferable mainland-China production latency figure.

### Updated assessment and release constraints

The revised assessment explicitly includes preserved staging performance, explains why the existing workflow cannot promote production without its staging dependency, and no longer recommends rolling staging back to the narrow source. The prior documentation/provenance concern is **resolved** for the inspected revision. The generic Skill addition correctly separates credential rejection from continuation failure and forbids credential/body/token collection. No consequential misstatement was found in the revised runbook's inspected scope.

The combined candidate legitimately carries previously reviewed performance changes into production; make this scope visible in the PR and root approval. Normal hosted checks must run on the final head and the main-push merge SHA, retaining the high-severity dependency gate and release checksum/main-head freshness checks. The new staging run should preserve code behavior from 9409202, but its distinct rebuilt version still needs readback and smoke. Root-authorized password-OAuth outcome verification must be privacy-safe; a new successful continuation is not evidence that an unrelated 401 was resolved. Capture current rollback versions before promotion and remember that rollback to the old production release restores both older performance behavior and the known password resume defect.

No fresh local tests/builds, audit, live probes or mutations were performed in this follow-up. Confidence is high in inspected source compatibility and exact runtime-tree equality; deployment execution, current advisory inventory and actual user-path behavior remain gated external observations.

The final pending assessment-only paragraph records parent-performed anonymous health/discovery/Login GET results. It changes no runtime source and correctly cannot establish credential acceptance, OAuth completion or exact rebuilt-artifact equivalence. This reviewer did not repeat those probes; their execution evidence remains attributed to the parent, with the final documentation commit/SHA to be recorded by the operator.
