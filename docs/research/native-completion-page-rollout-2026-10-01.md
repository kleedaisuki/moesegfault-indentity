# Native completion page ownership and rollout — 2026-10-01

## Status and reading scope

The ownership decision below remains current. The public Login, CI artifact, release-list,
and PR-status observations are a **historical snapshot from approximately 07:35
Asia/Singapore on 2026-10-01**, not a live deployment status page. Preserve their recorded
revisions and observation time when reusing them.

At documentation integration, fetched Identity main is
`08576c0549c3ab8d6b8b90f0fb6591b59962f5dd`, containing the issuer-origin OAuth resume
correction and preserved staging runtime. The earlier paragraph describing PR #19 as open
therefore must not be read as current main status. This documentation pass did not independently inspect provider deployment state. The separate
[production rollout report](pr19-production-rollout-2026-10-01.md) records main-run
[36793808744](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36793808744)
with all eight hosted jobs successful and 19/19 anonymous HTTP checks per environment. Production password **401 before successful authentication remains
unresolved** in the coordinating incident; the resume correction acts only after successful
authentication and does not prove that rejection resolved. Consult
[the production assessment](pr19-production-assessment-2026-10-01.md) for that failure-boundary
distinction, while respecting its own historical deployment observations.

Neither the main integration nor any Identity deployment delivers the embedded amail page to
the Login origin. Installed-binary and authenticated-flow acceptance remain separate evidence.

## Decision

The amail browser success/error page refinement `9cb410a7a4d05f60e76c2a5a8bed2681b87e8618`
is **an amail commit, not an Identity commit**. It changes only
`crates/amail/src/oauth_success.html` and `oauth_failure.html` in the sibling amail repository.
It cannot be deployed by the Login Worker. The final native page is served by the amail loopback
listener; shared Identity visual language does not change that owner.

Identity owns human authentication and authorization. The relying party alone can establish
whether token exchange, ID-token validation, and protected session persistence succeeded.
Source-branch commit `08c690e` recorded this distinction in `docs/integrating-app.md` and the Identity skill; this does not imply that the earlier source-branch commit was merged into main. The Skill guidance is included in this documentation integration.
No new Identity completion API, redirect registration, CORS permission, or authentication mechanism
is required. Existing clients and redirects must remain compatible.

## Evidence collected

Investigation time: approximately 2026-10-01 07:35 Asia/Singapore. No credentials, cookies,
authorization transactions, codes, tokens, account records, or mail bodies were inspected.
No local project build/test, provider mutation, workflow dispatch, or deployment occurred.

### Source and hosted build facts

- amail remote main is `a4fc6160ca6b771da6351268d1a96af4c4a616dc`; `git merge-base
  --is-ancestor 9cb410a origin/main` succeeded. The refinement is already merged.
- amail `auth.rs` uses `include_str!` for both pages. Persistence is the final fallible step
  before success. The loopback response has no-store, no-referrer, nosniff, denied framing,
  and a restrictive CSP. Callback parameters are not interpolated.
- [Five-platform release dry-run 36426742183](https://github.com/kleedaisuki/moesegfault-amail/actions/runs/36426742183)
  passed at `59c9b09274c1b25e50a1c612133a0af44a14c6a7`, a descendant of the page commit.
  GitHub still lists non-expired Windows, Linux x86_64/arm64, macOS Intel/arm64, and assembled
  `release-bundle-v0.1.0` artifacts. This is hosted build evidence, not a published release.
- [Recent CLI CI 36789400291](https://github.com/kleedaisuki/moesegfault-amail/actions/runs/36789400291)
  passed at `9499e7f20049b853b41da6790489f02fbfe20569`; its
  `amail-windows-smoke-9499e7f20049b853b41da6790489f02fbfe20569` artifact is non-expired.
- `gh release list` returned no published amail release. Installed executable provenance was
  not inspected, so an old installed binary remains a possibility, not a proven diagnosis.

### Safe public Login inspection

Anonymous GETs to `/login` on production and staging both returned 200 HTML, with:

| Fact | Production | Staging |
| --- | --- | --- |
| HTML cache policy | `no-store, no-transform` | same |
| HTML-linked JS | `/assets/index-BC7yChrU.js` | same |
| HTML-linked CSS | `/assets/index-1ICyddhu.css` | same |
| JS response | 200, `text/javascript`, 56,850 UTF-8 bytes | same |
| JS contains `amail` / local success-page English copy | no / no | no / no |
| JS cache policy | `no-store, no-transform, public, max-age=31536000, immutable` | `public, max-age=31536000, immutable` |

Both HTML responses have SHA-256
`cd2ff3b8769b375fb96579cc0eb3d99cffddcd37d3e6527bc0f6dbc619e0c005`.
Only allowlisted public-page facts were printed; no HTTP body was persisted. No authenticated
success/error view or active loopback callback was opened. Equal assets do not identify the
Worker revision or prove an authenticated flow. The cache-header difference is consistent with
the documented staging-only performance rollout, not evidence of callback-page delivery.

Identity remote main remains `56a501eb9de1c880fe93f44af7ad10e7586c0b41`.
[PR #19](https://github.com/kleedaisuki/moesegfault-indentity/pull/19) is open at `32064c9`,
with green checks and no GitHub reviews. It corrects password OAuth resume, not the amail page.
The documented performance staging release is `9409202`, via
[run 36752376608](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36752376608);
production promotion was skipped. Do not conflate pending provider promotion with the
already-merged native page refinement.

## Shortest compatible delivery path

1. Identify only the installed executable path/version and the **final page origin**, without
   collecting its query string. A final `127.0.0.1` page belongs to amail; a Login-origin
   ceremony state belongs to `apps/login` and requires a separate presentation assessment.
2. Select a reviewed immutable amail descendant of `9cb410a` with successful hosted CLI
   quality evidence, download its exact GitHub artifact under repository `.temp`, record the
   SHA and artifact digest, and launch that executable explicitly. Installation/replacement
   must be coordinated with the root task, not inferred from source being merged.
3. Verify the rendered static success/error pages and then the existing normal login workflow
   at proportional scope, with no secret/callback URL logging. Keep local sessions and
   credential-store configuration unchanged. Current inspection does not claim this
   installed-binary acceptance has passed.
4. If a current-main distribution bundle is needed, the existing `Release amail CLI` manual
   dispatch on main verifies all platform bundles without publishing. A version tag separately
   invokes real release gates; do not bypass held Mail/send prerequisites merely to deliver
   page styling. Any dispatch or executable change needs root coordination.
5. If the complaint is instead the provider's actual standalone Login success/error state,
   refine its existing shared shell/state panels without changing ceremonies, resume behavior,
   redirects, or tokens. Require exact-revision review and full hosted quality / immutable
   package gates, then the existing `staging-only` pipeline. Production is a distinct reviewed
   main promotion; no such code or deploy is justified by `9cb410a` alone.

## External contract references

- [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html): system-browser native authorization,
  registered loopback callbacks, and the separate application security domain.
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html): OAuth security best current practice;
  preserve PKCE, exact redirect policy, and transaction validation when changing presentation.

This is an ownership/provenance determination, not a new authentication design. Provider-hosted
completion would not prove successful local storage and would introduce an unnecessary
cross-owner dependency into a static presentation change.
