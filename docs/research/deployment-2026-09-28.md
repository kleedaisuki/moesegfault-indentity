# Release verification and deployment evidence — 2026-09-28

## Pull-request CI gate

- PR: [#15](https://github.com/kleedaisuki/moesegfault-indentity/pull/15), head `eef764e55867594848ba10c952ca00ecede9c0ad`.
- GitHub Actions: [CI and delivery run 36404628075](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36404628075), observed with `gh pr view 15 --json headRefOid,statusCheckRollup` and `gh run watch 36404628075 --exit-status --interval 15`. The watch exited 0.
- Successful jobs: Rust quality and Worker build; Login frontend; Account frontend; contracts, migrations, config, scripts; immutable deployment package; Required quality gate.
- The package job exercised the Worker request boundary, local contact creation and email-verification workflow, password authority/session rotation, and Wrangler dry-runs for all three release units. Its checksummed bundle was uploaded.
- Staging and production deployment jobs were **skipped by design** on this `pull_request` run (`if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'`). CI success is not deployment evidence.

## Post-merge release gates

These criteria come from [`infra/RUNBOOK.md`](../../infra/RUNBOOK.md), [`scripts/release.sh`](../../scripts/release.sh), and [`scripts/smoke.sh`](../../scripts/smoke.sh). Record the main-branch SHA, CI run, environment approvals, and each actual deployment outcome separately; do not treat the PR run as the deployment run.

1. Verify merge commit is the intended reviewed change and that its main-branch run passes the same quality/package jobs. Confirm the checksummed package is the one consumed by both environments.
2. In staging, ensure required runtime secrets exist. The release script must list/apply remote D1 migrations **before** deploying Identity, then deploy Login and Account. The script must exit 0 after `scripts/smoke.sh staging`.
3. Staging smoke checks deep `/healthz` including D1, OIDC discovery, both HTML frontends and security headers, credentialed Account-origin CORS on `/v1/me`, Account-origin mutation boundaries, and rejection of untrusted origins. These are anonymous contract probes, not proof of email delivery or an authenticated OAuth flow.
4. Before production promotion, verify a controlled staging mailbox receives a fresh code and an authenticated browser can complete contact verification. Check the contact response contains a canonical `contact_id` with equal compatibility `identifier_id`; do not log secrets or full email addresses. Email Service acceptance or a local simulated send is not recipient delivery.
5. Confirm production environment approval and the production job's stale-main guard. It must deploy the **same** bundle, run remote D1 migrations and three units in the same order, and exit 0 after `scripts/smoke.sh production`. The production smoke has the same limits as staging smoke.
6. Independently check the Cloudflare WAF edge rule for `POST /v1/password/authentications`; the in-app D1 attempt limit does not establish that the edge rule exists. Observe logs/traces, error rates, outbox age and Cron after rollout. Follow the runbook's rollback policy if regression appears; rollback does not undo D1/R2 changes.

**Current evidence boundary:** no authenticated deployed contact workflow, controlled external inbox, environment approval, remote D1 migration, or live deployment is established by this PR CI run alone.

## Main-branch deployment run

- PR #15 merged at `2026-09-28T09:41:05Z`; main commit `d336ac3b786d16fba471dc1cefe40c98c4096e51`.
- Repository environment inspection before merge found `cloudflare-production` had **no required-reviewer protection rule**, despite the runbook's stated protected-approval design. The production job therefore started automatically after staging; no manual approval was observed. This is an operational governance gap to correct separately, not evidence that the deploy failed.
- [Run 36405063146](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36405063146) has the exact main commit as `headSha`. `gh run watch 36405063146 --exit-status --interval 20` exited 0; all quality, packaging, staging, and production jobs succeeded. The release job verified the bundle checksum, unpacked it, ran `scripts/release.sh`, and therefore ran the remote migration/deployment/smoke sequence.
- The staging [job 108872950706](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36405063146/job/108872950706) applied D1 migrations `0005_oauth_pairwise_session.sql` and `0006_password_rate_limit.sql` with success marks, then reported Identity version `3056d8ee-1221-444b-873d-ebbec9cbc82e`, Login `52f096ec-69c1-4607-9585-0dbd6371ef5a`, and Account `d3498561-54b1-4f71-b0f3-6caa640ac57d`. Its log ended `smoke checks passed` at `2026-09-28T09:45:32Z` for all three staging domains.
- The production [job 108873219385](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36405063146/job/108873219385) applied the same two D1 migrations with success marks, then reported Identity version `1df5b211-32d4-44fb-a593-7e66c2066667`, Login `fd3edc34-ac85-451e-99f6-4745dd178fb4`, and Account `4b7e35c9-e5f7-4934-92f7-39fdf609f3e3`. Its log ended `smoke checks passed` at `2026-09-28T09:46:17Z` for all three production domains.
- Wrangler printed `No targets deployed` after Login and Account upload in both environments. This wording alone is inconclusive. Independent HTTP GETs of the four frontend domains returned 200, and each HTML page's JS/CSS asset fingerprints exactly matched the downloaded main-run immutable frontend artifacts: Login `index-BC7yChrU.js`/`index-1ICyddhu.css`; Account `index-Deq0DLZ8.js`/`index-CBW-GHHn.css`. Command basis: `gh run download 36405063146 -n <app>-assets-d336ac3b786d16fba471dc1cefe40c98c4096e51 -D .temp/release-verify/<app>`, then PowerShell `Invoke-WebRequest` and regex comparison of `assets/` references. This supports that the public frontends serve this release, despite the Wrangler message. It does not independently identify the executing Identity Worker version.
- Independent unauthenticated GETs of staging and production `/healthz` returned `status=ok`, `checks.d1=ok`, `version=0.1.0`. The app version string is not a unique build fingerprint; the CI deploy log is the evidence for the newly deployed Identity version IDs.

## Remaining release-verification limits

The automated smoke does **not** exercise a logged-in contact flow, real recipient delivery, or a complete third-party OAuth authorization-code flow. No controlled mailbox or account was available to this validator. Cloudflare WAF edge-rule configuration and post-deploy operational metrics also remain separately unverified. Do not equate successful outbox/service acceptance with inbox delivery. A controlled staging mailbox test and WAF check remain follow-up gates; if staging was already promoted automatically, perform them promptly and treat a failure as an incident rather than calling the release fully validated.
