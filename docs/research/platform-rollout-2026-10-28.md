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
