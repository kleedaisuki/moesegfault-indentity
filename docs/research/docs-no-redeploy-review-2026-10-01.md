# Independent review: documentation-only Identity delivery filtering

Date: 2026-10-01 (Asia/Singapore).
Candidate: `c83d00de282ba054a395664a89c4a7e1369836b7`.
Baseline: `08576c0549c3ab8d6b8b90f0fb6591b59962f5dd` (`origin/main` at review).
Worktree: `.temp/identity-docs-no-redeploy`.

## Decision

**GO for hosted source checks only. No blocking implementation defect found.**
This is not permission to merge, promote staging/production, or infer a successful
live docs-only merge. No project tests or builds were run locally. No provider
request, push, dispatch, or production source fix was performed during this review.
`git diff --check` passed; the three-file candidate diff was inspected completely.

## Verified source contract

- `.github/workflows/ci.yml:4-17`: `paths-ignore` is indented under `push`, after
  `branches: [main]`; it is not attached to `pull_request` or `workflow_dispatch`.
  The PR event remains unconditional. Existing PR Rust, both frontend matrix jobs,
  contracts, package, and `Required quality gate` remain configured.
- All six ignored patterns target named Markdown locations or Skill agent YAML.
  Runtime Rust/TS, migrations, lockfiles, Wrangler config, delivery scripts, and
  workflow policy itself remain outside the ignore list. No runtime build import
  of these ignored documentation paths was found in inspected scripts/config.
- The package dependency and both deployment conditions are unchanged from the
  baseline. Eligible main pushes still stage a tested immutable package before
  production; production still rejects a stale main SHA. A mixed runtime/docs
  change remains eligible under ordinary GitHub changed-file evaluation.
- `workflow_dispatch` remains available with `verify-only` as default and
  `staging-only` as the sole deployment option; it adds no manual production path.
- The contracts job explicitly executes the new test file with `node --test`.
  The test is not orphaned or dependent on glob-based test discovery. It checks
  the actual event header/list, positive and negative path examples, explicit
  dispatch defaults, package/deployment dependencies, and stale-run rejection.
  Its path evaluator is a deliberately limited model, not a full YAML parser or
  independent execution of GitHub's glob engine. Hosted CI must still validate
  syntax/execution; a future ordinary docs-only merge can validate actual routing.

## Official platform evidence and limitations

[GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)
was consulted live. All matching ignored paths suppress that push event; one
nonmatching path preserves it. Branch and path filters both apply. Existing-branch
pushes use two-dot diffs. Skipped required PR workflows could leave pending checks,
but this candidate does not filter PRs. Native large-diff limits and large-push or
timeout fallbacks mean this optimization is not a security boundary or absolute
promise that every enormous mixed change will deploy.

## Non-blocking correction

`infra/RUNBOOK.md` currently says the native diff limit is 300 files. The official
GitHub page read during this review says **3,000 files** (and over 1,000 commits or
diff-generation timeout cause an unconditional run). Update the number, or omit
the numeric limit and link the live documentation to avoid future drift. This
outdated conservative warning does not change the executable event filter.

Status at review-artifact commit: the implementation owner is preparing this
RUNBOOK correction separately; it is pending and requires follow-up verification.
This review decision applies to c83d00d, not an uninspected future revision.

## Required next evidence

Run the candidate's normal hosted PR/source checks. Do not replace them with a
local test run or a skip-ci marker. The policy commit changes the workflow and
therefore is itself outside the ignore list; its main merge can still trigger the
existing automatic staging/production rollout. Record this distinction before
merging. Later docs-only merges should have PR quality evidence without a new
main-push delivery run; no provider mutation is needed to review this candidate.
