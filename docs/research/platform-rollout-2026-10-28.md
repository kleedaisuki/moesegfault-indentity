# Notifications and Decisions rollout — 2026-10-28

## Release scope

Release 0.2.0 introduces Notifications and Decisions, migrates both pre-account
and account-contact verification mail from Identity to Notifications, and refines
the Account interface without changing the established browser API contract.
Deployment uses GitHub Actions exclusively; staging is explicitly authorized.

The source starts at main `615945e`. Existing local journey changes were already
published there. Unrelated mskill registration commits from the previous local
branch were not imported; their original history remains at
`codex/pre-platform-preserve-20261028`. Existing unrelated working-tree changes
and documents are not included in this release.

## Coordination choices

The work was split into platform, Identity transport, Account presentation, and
delivery ownership, with a separate independent reviewer. The platform lead could
delegate two leaf implementations, but further recursive delegation was disallowed.
The root integrated commits, protected unrelated local state, and alone controlled
publication. Contracts and file ownership were agreed before parallel edits;
cross-service tests checked the assembled result, not just per-agent completion.

This applies the centralized integration and explicit dependency lessons from
[Effective Strategies for Asynchronous Software Engineering Agents (2026)](https://arxiv.org/abs/2603.21489)
and role-separated review from [Agyn (2026)](https://arxiv.org/abs/2602.01465).
The shared checkout uses disjoint ownership rather than claiming full worktree
isolation or importing benchmark accuracy claims into this production task.

## Verification before hosted delivery

- Strict TypeScript checks pass for shared platform, Notifications and Decisions.
- 28 focused platform tests and the real-D1 multi-Worker journey pass, including
  private capability separation, sender creation/reuse, HTML escaping, encrypted
  payload erasure, provider retry, explicit confirmation, origin/cookie/CSRF,
  concurrent single consumption, and callback failure/recovery.
- Account's focused presentation tests, typecheck and production build pass.
- Delivery/provisioning tests, ShellCheck, Bash syntax/environment checks, and
  immutable bundled Worker deployment dry-runs pass.
- `npm audit --audit-level=high` reports zero vulnerabilities after upgrading
  Wrangler to 4.154.0, Happy DOM to 21.0.4, Vite to 7.3.7 and Vitest to 4.1.12.
  This is a security-driven tooling update, not unrelated dependency churn.
- Rust formatting passes. New Rust/WASM compilation and full existing frontend
  suites run on hosted Actions rather than consuming the local workstation.

## Hosted delivery

First staging candidate: `9ac2f89c707e4781159973a808fe4af9514f951f` in
[run 40648902822](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40648902822).
At note creation, platform contracts/package, both full frontend suites/builds,
and shared contracts/migrations/scripts had passed. Rust and actual delivery
were still running. A queued or successful build is not evidence of deployment.

The first run subsequently failed only its fresh Rust advisory gate:
`RUSTSEC-2026-0387` affected the old crypto-bigint transitively used by vendored
Passkey verification. Rust formatting, clippy and native tests had passed; no
deployment occurred. A stable, MSRV-compatible upstream dependency migration is
being evaluated rather than ignoring the advisory. The failure also exposed that
dependency/tool caches must survive later validation failures, while validated
application artifacts must remain success-only.

## Real-user acceptance constraints

The installed amail CLI requires a human approval before creating this task's
non-user testing profile. No approval was automated, and no existing mailbox was
read, marked or deleted. The requested mailbox/browser journey remains pending
that normal CLI authorization and a task-owned temporary staging address.

The in-app Browser connection currently fails creation, navigation, DOM snapshot,
and accessibility operations with an internal `constraints` error. Both documented
troubleshooting paths were checked; the only other advertised backend is an
existing-MCP-app surface that cannot navigate web pages. Opening a preview tab
through Codex succeeds, but does not establish usable browser interaction.
Do not claim visual or browser acceptance until that surface actually works.

The dedicated staging journey workflow supports HTTP-level confirmation and a
separate mailbox/browser mode. Neither replaces the other's evidence. Production
must retain private send/create entrypoints and an explicit callback registry;
capability links are not a substitute for step-up authentication for high-risk
account mutations.

## Completed staging acceptance

The stable crypto upgrade passed native and WASM checks and 48 vendor tests,
including historical high-S/low-S DER signatures. The subsequent real-WASM
integration gate caught a separate runtime incompatibility: Workers rejects
`redirect: "error"` before invoking a receiver. The SDK exposing that enum does
not make it a supported edge behavior. Notifications and the two existing
external-provider fetch sites now use `manual` and exact expected status checks;
the named-entrypoint registration/contact harness also covers redirect rejection.

[Run 40653204839](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40653204839)
deployed all five services to staging and passed discovery, D1 health, frontend,
CORS, origin/capability and private-platform-ingress smoke checks. Staging stores
were created once and subsequently pinned:

| Service | D1 ID |
| --- | --- |
| Notifications | `121c47f4-71b5-44f3-92cb-73ada2cb98d9` |
| Decisions | `6c305f96-9b50-4f6b-90e4-d5d8c77c71a3` |

Two live probe defects were resolved without weakening acceptance: allow bounded
read-only checks for deployment/secret propagation before creating anything, and
clone service-binding responses before mutating their immutable headers. The
exact forwarding path is now in the real-D1 test. The probe waits for invitation
handoff before confirming the form, so it cannot accidentally skip its own email.
Unexpected responses retain operation, HTTP/MIME, CF-ray, correlation and bounded
redacted content. Failure-only direct D1 metadata queries work even if the fixture
API itself is broken.

The registered bootstrap workflow now has a staging-only acceptance path that
does not rebuild or redeploy applications. Its
[run 40659802668](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40659802668)
passed native provider acceptance, non-consuming GET, explicit HTTP confirmation,
and the durable registered callback, then restored the fixture inert. The observed
decision was `b385e2c4-937a-447c-b18e-5cc8af62fe3d`; no capability URL is recorded.

The user changed the controlled destination to Outlook after amail's saved
session refresh failed and renewed browser authorization remained invalid. The
user independently confirmed receipt of both security and decision mail. A real
anonymous staging Identity email request then returned201 with transaction
`01a181ba-804b-71ed-9a31-bc6f722814a5` and correlation
`01a181ba-8042-7077-8469-181b2400e661`; the user also confirmed that Identity mail
arrived. No account was created and no OTP was requested from the user. This
supersedes the earlier pending-mailbox constraint, but not the browser limitation.
The connected Outlook account could not independently retrieve that recipient's
mail; do not present user-confirmed receipt as connector-observed receipt.

Final PR source quality and immutable packaging passed in
[run 40659808916](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40659808916).
[PR27](https://github.com/kleedaisuki/moesegfault-indentity/pull/27) was merged with
an exact head-SHA guard, preserving atomic commits, as
`f9b2e1b66b3a510969c0e5b1eb8c05c60b166b08`. Its normal main-push staging/production
promotion is [run 40660747279](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40660747279);
it was still running when this section was written.

## Pre-promotion rollback baseline

The previous successful main delivery was
[run 37644876656](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/37644876656).
Read-only production probes before promotion still reported Identity0.1.0 and the
same hosted Login/Account assets. Known-good rollback versions are:

| Unit | Version |
| --- | --- |
| Identity | `27174a03-7574-467f-a226-d6b954630ae2` |
| Login | `79e557d2-ecc5-4c71-9e4d-282164b8880c` |
| Account | `1438e069-f685-4d09-843c-d84b9d96a8a3` |

Restore frontend code before Identity if rollback is required. Retain the new
services and accepted outboxes, and never restore D1 snapshots, which can revive
revoked credentials or grants.

## Production delivered

Both main-push promotions succeeded, including the final production-store pin:
[run 40660747279](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40660747279)
and [run 40662458557](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40662458557).
The final deployed application revision is
`ed1c36ac00713a24de01fc886c7d5ae710f22d9f`. Runtime/API behavior is unchanged by
the latter two-line infrastructure commit; it pins the stores actually created
by the first promotion so future releases reject missing/replaced data resources.

| Production unit | Final Worker version |
| --- | --- |
| Notifications | `329dbeaf-d3df-431a-80eb-13ae65379763` |
| Decisions | `6b089714-55a6-4241-b65b-a71d63f7d779` |
| Identity | `f505b465-1aff-4167-875f-8138f01b027d` |
| Login | `7ff0bf34-b234-48f8-aa82-7d7105989fd8` |
| Account | `ad39f690-9e60-468e-8f48-b4a97c2e279e` |

| Production store | Pinned D1 ID |
| --- | --- |
| Notifications | `6a3d613a-4e46-4775-8ff0-742fcc7a59cc` |
| Decisions | `38507781-e814-4488-a831-fd54f801ac77` |

Independent read-only probes observed HTTP200 for both new landing pages and
their D1-backed health routes, Identity version0.2.0/D1 healthy, production-matched
Account navigation, and HTTP404 for public POSTs to the private send/create APIs.
The Account public entry `/assets/index-C88fI03X.js` exactly matches its hosted
artifact, SHA256 `5a634885bbf89a383374f1edf049cdccb807b06e2339bbfee88cb6dea2e25161`.
After the pin promotion, Login `/assets/index-CjKOcMGe.js` matches the final hosted
artifact, SHA256 `cf03770ca8c9ef3d0fed89c4fd8d4f8017e0bcef869e87b9b75c41652cd962b2`,
and contains the exact final deployed revision for support receipts.

No production account was created or modified, no production test mail was sent,
and no database snapshot was restored. Existing unrelated local working changes
remain outside this delivery.

## Open acceptance item: actual built-in Browser

The user explicitly required this acceptance in the current task and declined
deferring it. **Do not mark the goal complete merely because production is healthy.**

The root used the advertised in-app browser, not an external browser. Metadata
calls can list an Account page with its live title, but navigation, AX/DOM reads
and screenshot actions still fail with `Cannot read properties of undefined
(reading 'constraints')`. Recreating the automation session after documented
troubleshooting did not resolve it. The advertised, origin-scoped CDP read-only
developer path timed out and reset the kernel. A bounded independent-agent probe
advertised no browser backend at all. No hidden browser implementation or external
automation mechanism was used to bypass these failures.

The user was asked to reopen/reconnect the current task's built-in browser. Resume
with a generic page/AX read first; do not send another invitation until browser
control actually works. Then validate Account navigation and narrow/dark layouts,
and run the staging `mailbox` acceptance mode for a fresh decision: choose, fill,
explicitly submit, verify completion and the durable callback, and save screenshots.
The previous HTTP round trip and user-confirmed mail receipt remain valid evidence,
but are not substitutes for that requested browser interaction.
