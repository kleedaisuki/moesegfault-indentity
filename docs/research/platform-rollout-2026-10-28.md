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

## Earlier acceptance blocker: actual built-in Browser

The user explicitly required this acceptance in the current task and declined
deferring it. At this checkpoint production health alone did not prove completion.
The later recovery and completed acceptance below supersede this earlier blocker.

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

## Browser acceptance completed and final 0.2.0 state

After the user repaired the connection, the in-app browser completed the real
staging decision journey: choose `approve`, fill `staging-ok`, separately confirm,
follow the native completion redirect, and observe the submitted page. The actual
registered service receipt was confirmed by successful
[mailbox/browser run 40699666946](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40699666946).
The observed decision ID was `a18a15ac-5e5e-4f4c-be42-fcb60c7fa0c2`; no bearer URL
is recorded here. The earlier rejected native POST and corrected protocol/test
transport are explained in
[the native-Origin incident](../incidents/2026-10-28-native-decision-origin.md).

The user then explicitly chose a seven-day default with longer caller-specified
business deadlines. [PR29](https://github.com/kleedaisuki/moesegfault-indentity/pull/29)
implements that contract, rather than asking asynchronous recipients to watch
their inbox. Admission defaults are applied once and are independent of message
delivery and CI observation. New encrypted invitation snapshots freeze outbound
JSON; old records retain their original serializer and accepted idempotency key.
Thirty/ninety/365-day cases, omitted-expiry retries, legacy encrypted records, and
late private callbacks after public-driver cleanup are covered by actual Workers
and D1. The one-year admission safety ceiling is configurable; accepted records
are not rewritten when policy changes. Verification codes retain their short
security lifetime. Queue-only expiry is not presented as the validity of an
ordinary informational/security message.

[Source/native gates 40704220756](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40704220756),
[exact-candidate staging/HTTP acceptance 40704050563](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40704050563),
and [production promotion 40705586193](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40705586193)
all passed for this asynchronous-lifetime change.

Account actual-page theme/locale/navigation and desktop/narrow display checks also
completed. A clearly synthetic authenticated-shaped fixture used the real shell,
pages and CSS, not a forged Identity session, and exposed the compact-header
ownership issue fixed by [PR30](https://github.com/kleedaisuki/moesegfault-indentity/pull/30).
Its source/native/package gates passed in
[run 40704236673](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40704236673).
See the [Account presentation note](account-presentation-refresh-2026-10-28.md)
for measured bounds and the distinction between fixture, actual-page and capture
evidence. No profile save, authentication or sign-out persistence is claimed by
the synthetic display fixture.

The final application revision is
`5e0dae68826d89aaf2832625fa4f69abfe831d87`. Its complete hosted quality/package,
staging and production promotion succeeded in
[run 40707342063](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40707342063).

| Final production unit | Worker version |
| --- | --- |
| Notifications | `cfae9af1-eaa2-440d-8091-c7d36d23c9e8` |
| Decisions | `3ff930b8-b6eb-4c88-bdad-b318c6dd3411` |
| Identity | `a074006d-fecf-4b53-a77e-c737c7a93fe1` |
| Login | `7aa017cc-2e45-4e9f-8151-8cee45b51bdf` |
| Account | `1c59e83f-29dd-4d37-8cd7-85e6e44fa09d` |

Independent final readback confirmed Identity0.2.0/D1 healthy, both new services
healthy with strict-origin, and public POSTs to private send/create paths returning
404. Existing pinned D1 IDs were reused. Every first-party npm manifest reports
0.2.0. Public frontend bytes exactly matched the final hosted artifacts:

| App | Entry | SHA256 |
| --- | --- | --- |
| Account | `/assets/index-CNQzDJn4.js` | `f18525e9ea2fe4325c1c18f0f4b2d1b02da1ea4ad75fc0fa62f12d02e88daf1f` |
| Login | `/assets/index-C4ZFXKix.js` | `e337647d56a0e9e99f93a5098566988fd5d013c189a12bb04d870d138f327bc7` |

The callback consumer retains its D1-only private binding when the public test
driver is disabled; no sending/control bindings or public token remain necessary
for a late reply. The temporary sandbox workflow branch was deleted only after
verifying its expected owned head and receiving deletion204 plus ref-not-found404.
No production test mail, account mutation, secret rotation, data snapshot restore,
or changes to the user's unrelated working-tree files were used for final
acceptance. The in-app Browser blocker is closed by actual interaction, not waived.

## Fresh recipient acceptance — 2026-10-28

The remaining native-provider question was whether successful mail to the controlled
base Outlook mailbox could have relied on an individually verified Cloudflare
destination. Earlier notes documented real receipt but did not establish the
verification status of that exact address.

Microsoft explicitly documents Outlook.com `+site` addressing as delivery to the
same existing inbox: [Outlook.com site-specific addresses](https://support.microsoft.com/en-us/outlook/send-email-from-a-different-address-in-outlook-com).
Cloudflare's current limits distinguish verified destinations from an onboarded
sending domain, which may send to any recipient:
[Email Service recipient limits](https://developers.cloudflare.com/email-service/platform/limits/).

A staging-only HTTP journey used a fresh, cryptographically random 64-bit plus-tag
of the user-authorized Outlook address. No destination registration, confirmation
email or OTP flow was performed. Recipient SHA256:
`231cb35e4a2c1daf81d31dd94a3073f3b966ae757facd120d640b138165c5f5a`.
[Run 40713749593](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40713749593)
used main `5cb3e6236dded2272098d42d1f277a2d8337c57f` and completed successfully in
63 seconds. At 15:14:13 UTC the driver reported native provider acceptance, explicit
HTTP confirmation and durable registered callback for decision
`c88fbde3-a136-4e91-be0c-894f128bbcfb`. The driver checks the notification's native
provider state is `sent` before declaring success. This proves the configured
structured Email Sending path accepted the newly generated recipient; it is not
an additional inbox-receipt or browser-interaction claim.

Only the temporary staging fixture was deployed; no application release, full
build, production operation or deployed application-code change occurred. The
workflow disabled the public driver while retaining its private DB-backed callback
consumer. A `finally` block restored `PLATFORM_JOURNEY_RECIPIENT` to the exact base
address; the successful secret update was confirmed at 15:14:41 UTC. The original
recipient was not replaced with the plus-tag in any source or documentation.

Separate root in-app production acceptance also confirmed Notifications' **Your
account** link opens production Account, whose anonymous entry points to the paired
production Login return URI. No authentication or account mutation was performed.

## Portable integration skills

[PR31](https://github.com/kleedaisuki/moesegfault-indentity/pull/31) publishes
`skills/moesegfault-notifications` and `skills/moesegfault-decisions` alongside the
existing Identity skill. Each new folder is independently copyable: short
`SKILL.md` entrypoints route to bundled references only when the current task
needs integration, templates/forms, callback registration, or operational detail.
No relative reference escapes its skill folder, and maintainer source links are
not prerequisites. README indexes selective installation through the
[upstream Skills CLI](https://github.com/vercel-labs/skills#install-a-skill).
The layout follows the [Agent Skills specification](https://agentskills.io/specification),
without inventing an SDK, provider credentials, public send API, or access grant.

Both system skill validators passed. All four embedded TypeScript blocks passed
strict checking against the installed Cloudflare runtime types and Zod, including
exact optional properties and unchecked-index checks. The callback SQL example
uses a unique receipt insert, an operation/decision foreign key, a pending-state
trigger, and one D1 batch: a duplicate or failed effect rolls the whole batch back,
rather than allowing an ignored insert followed by a repeated mutation.

An independent consumer exercise read only each supplied skill and its selected
bundled references, not platform implementation or service READMEs. With Node's
built-in test runner and SQLite, it produced two isolated service integrations:

| Exercise | Result | Discriminating behavior |
| --- | --- | --- |
| Notifications | Strict build; 18 offline tests passed | Chinese security notification, paired environments, response lost after acceptance, restart with unchanged envelope/key and the same receipt, terminal/conflicting outcomes |
| Decisions | Strict build; 13 offline tests passed | Thirty-day choice/form, required region and optional note, both sides of registration, early callback before mapping, eight duplicate contenders, conflicting events, failure rollback, commit followed by lost completion signal |

These are consumer-control-flow and local SQLite transaction checks, not a claim
of distributed D1, new mailbox receipt, or new browser acceptance. The actual
runtime journeys above remain separate evidence. The exercise found no blocking
contract gap; receipt loss through the entire delivery window without a known
message ID still requires operator reconciliation rather than an invented lookup
API or renewed deadline.

[Hosted run40716622045](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40716622045)
passed the existing required quality/package and native-browser gates before
merge. Validated Rust, frontend and Identity integration artifacts were reused;
the fresh advisory gates still ran. These changes are skills/README only, so the
documentation-only main filter correctly avoids deploying identical application
code again. Production remains the verified0.2.0 application revision above;
Notifications, Decisions and Identity health checks were independently200. A
copied skill neither registers a callback nor grants a service binding, and live
onboarding/deployment still requires the current task's authorization.
