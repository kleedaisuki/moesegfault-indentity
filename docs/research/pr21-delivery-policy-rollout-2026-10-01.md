# PR21 delivery-policy rollout — 2026-10-01

## Verdict and scope

PASS: exact main-source hosted quality, immutable packaging, automatic staging-before-production promotion, independently read-back active source/100% traffic and safe anonymous HTTP contracts. No failure or rollback recommendation arose within this scope. No manual deploy, provider mutation, dispatch, retry, credential/account lookup, local project test or build was performed.

Main SHA: `e56b6b474bd7d972301e8d05f37ad5d83949df37` ([PR #21](https://github.com/kleedaisuki/moesegfault-indentity/pull/21)). [Automatic main-push run 36796561218](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36796561218) completed SUCCESS. Fresh remote-main readback still matched this SHA.

Runtime source, frontend sources, deployment configuration and package lock are unchanged from parent `08576c0`. Changed paths are `.github/workflows/ci.yml`, `scripts/tests/delivery-workflow.mjs`, `infra/RUNBOOK.md`, and `docs/research/docs-no-redeploy-review-2026-10-01.md`. This merge changes delivery machinery, so its automatic delivery is expected; it is not a documentation-only merge. New provider versions really were created even though business runtime code is unchanged. No migrations were applied.

## Hosted jobs

| Job | ID | Result | Start UTC | Completion UTC |
| --- | --- | --- | --- | --- |
| Contracts, migrations, config, scripts | 110161226145 | success | 10/01/2026 00:30:56 | 10/01/2026 00:32:28 |
| account frontend | 110161226299 | success | 10/01/2026 00:30:55 | 10/01/2026 00:31:16 |
| Rust quality and Worker build | 110161226364 | success | 10/01/2026 00:30:56 | 10/01/2026 00:33:20 |
| login frontend | 110161226373 | success | 10/01/2026 00:30:55 | 10/01/2026 00:31:17 |
| Immutable deployment package | 110161858764 | success | 10/01/2026 00:33:23 | 10/01/2026 00:34:38 |
| Required quality gate | 110162192872 | success | 10/01/2026 00:34:41 | 10/01/2026 00:34:44 |
| Deploy and verify staging | 110162193703 | success | 10/01/2026 00:34:41 | 10/01/2026 00:35:22 |
| Promote verified revision to production | 110162384848 | success | 10/01/2026 00:35:26 | 10/01/2026 00:36:02 |

Both promotion-job logs independently confirmed the inner release tarball checksum, successful artifact download, smoke checks passed, and no migrations to apply. The same immutable artifact `release-e56b6b474bd7d972301e8d05f37ad5d83949df37` (ID `11133638907`, 1,026,465 bytes, nonexpired) was consumed; its GitHub archive digest is `sha256:df75c5b1654ff4380335082e66f0eafbaef61ed51f88c894af22cd39975c3787` (not the inner tarball digest). Production started only after successful staging verification.

## Independent provider metadata readback

| Environment | Unit | Active version | Deployment | Traffic |
| --- | --- | --- | --- | --- |
| staging | identity | `7e465bfc-4d93-43eb-bfa3-61422bec0777` | `69203155-0a07-4ded-9d7e-4e333471254e` | 100% |
| staging | login | `54afcd03-116b-4fb3-85dd-90845b7b4e54` | `1bf7e614-a7b8-4a66-9edb-e697f697e330` | 100% |
| staging | account | `796df796-64cc-45da-9372-295d28f8dde7` | `151d6b43-5d87-4479-bb3d-298e43c6d202` | 100% |
| production | identity | `a08f1dbb-6078-4fae-b258-e534b5b7bad3` | `ded660a4-5d31-4f0e-a2bc-9c5ee087a840` | 100% |
| production | login | `4b0052cc-9a0b-4686-bd4a-c32740db4ea9` | `3e3351f3-be70-4f5f-8a81-3f827a1abcb4` | 100% |
| production | account | `43ef6c15-e4d6-4d49-bb3f-b208b59a6c89` | `33cc4ee8-ddc8-4258-b11c-25ab6b1afda7` | 100% |

Each single active version and deployment source annotation exactly matches the new SHA. Compatibility date remains `2026-09-15`. Identity public environment/issuer/Login/Account/avatar/OAuth/RP bindings, D1 database and R2 buckets were matched against their paired environment configuration. Required secret binding names/types and email binding are present; no secret value was queried. Login and Account remain static frontends. Read-only provider metadata was reduced to allowlisted non-secret fields before persistence.

## Independent bounded anonymous HTTP acceptance

Both environments passed 19 requests each: staging at `2026-10-01T00:37:29.923Z`, production at `2026-10-01T00:37:42.327Z`. Health returned 200 with status and D1 check `ok`; discovery returned 200 and exact fixed issuer. Login HTML/mutable SVG preserved `no-store, no-transform`; Account HTML/mutable SVGs preserved `public, max-age=0, must-revalidate`. HTML-linked hashed JS/CSS returned 200 and conditional 304 with `public, max-age=31536000, immutable`, CSP/nosniff/same-origin COOP preserved. Anonymous `/v1/me` returned expected 401 `authentication_failed` with correct Account-origin CORS; password PUT preflight returned expected 204/PUT allowance.

These requests used no authentication, cookies, redirect following, retries, or authenticated mutations. Response bodies existed transiently in memory only; persisted results contain allowlisted public headers/statuses/timing. This does not prove the original user password rejection is fixed, successful production password-OAuth resume, or relying-party token persistence. The anonymous 401 is expected, not a reproduction of the reported password-login failure.

## Reproducibility and retention

Safe verification harnesses and evidence are repository-local under `.temp/identity-policy-rollout-evidence-20261001/`, adapted from the earlier PR19 verification harness without weakening assertions. Exact commands:

```powershell
gh run watch 36796561218 --interval 30 --exit-status
gh run view 36796561218 --json status,conclusion,jobs,headSha,url
& ./.temp/identity-policy-rollout-evidence-20261001/verify-deployments.ps1 -ExpectedSha e56b6b474bd7d972301e8d05f37ad5d83949df37
node .temp/identity-policy-rollout-evidence-20261001/verify-http.mjs staging
node .temp/identity-policy-rollout-evidence-20261001/verify-http.mjs production
```

Readback used existing local Node, curl.exe and pinned Wrangler `4.144.0` for remote read-only operations, not project tests/builds. Evidence includes `run.json`, `artifacts.json`, `promotion-summary.json`, six minimized version reports, and two anonymous HTTP reports. This report is recorded in an isolated detached `.temp/identity-policy-rollout-20261001` worktree and is not pushed or main-merged by the monitor. Future documentation-only merges should exercise the new nondeploying policy; that future live behavior is not claimed verified by this deployment-bearing merge.

## First live docs-only main-push check (PR20)

Bounded read-only GitHub verification after [PR #20](https://github.com/kleedaisuki/moesegfault-indentity/pull/20) merged to main at `2026-10-01T00:39:25Z`: commit `bba313d7f357fa01037516ba913e45c2290b4283` changes only two `docs/research/*.md` files and `skills/moesegfault-identity/references/oidc-integration.md`. No workflow/runtime/config/lock changes are present.

Observation at `2026-10-01T00:41:10.6237982Z` was 105.6 seconds after the recorded merge, followed by a bounded exact-SHA query in the same observation sequence. The recent Actions list contained no run for this SHA; the exact-SHA Actions API returned `total_count=0`. Commit check-runs returned `total_count=0`; legacy commit statuses also returned `total_count=0` with an aggregate `pending` state. That aggregate is the empty-status API default, not evidence of a queued workflow.

The recent Actions API had already recorded the later, unrelated PR event run `36797317516` at `00:40:08Z` (head `ed5f16cb208f7d6de03f3580f74e7c0aa08e4b10`), while the last main-push CI/delivery run remained `36796561218` for the deployment-bearing policy SHA. Repository event records separately showed PR20 merged at `00:39:25Z` and a later branch PushEvent at `00:40:05Z`. A distinct public PushEvent for this main merge was not present in the sampled feed and is not invented. The merged PR record and exact merged commit API establish the merge/source; later processed Actions events reduce the concern that the zero-run readback was simply taken immediately after merge.

Verdict: within this explicit bounded observation, the first docs/Skill-only main merge created no CI/deployment workflow run, consistent with the new policy. This is not a promise that no future manually dispatched run can target the SHA, nor indefinite monitoring. No provider read or write was required; no deploy, retry, push, user credential query or local project test/build was performed.

Queries: `GET /repos/kleedaisuki/moesegfault-indentity/pulls/20`; recent Actions runs; exact-SHA Actions runs; commit/check-runs; commit/status; repository/events; commit file metadata. Final report append time: 2026-10-01T00:41:52.2567570Z.
