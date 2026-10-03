# Independent review: Login safe failure receipt

Date: 2026-10-01.
Candidate: `7b55f4955d87e5765a96b3b4b6790b97491c7149`; production change `3805a888`, compared with main `08576c0549c3ab8d6b8b90f0fb6591b59962f5dd`.

## Decision

**GO for hosted source verification only.** No substantive introduced defect found in the bounded receipt change. This is not hosted-test completion, browser accessibility certification, live credential verification, or proof that the user's original 401 is fixed. No run for this candidate was visible in the bounded GitHub run list at review time.

## Evidence and scope

Reviewed all changed Login code and tests, the request/error parser, shared DOM primitives, authentication completion/navigation, Login package/TypeScript/Vite configuration, hosted frontend CI and the candidate scope document. `git diff --check` passed. No local project tests, typechecks or builds were run; no live authentication/provider mutation, push, or production edits occurred.

- Receipt serialization constructs a new object with a finite eight-code problem allowlist. It does not spread response/errors or read form credentials, cookies, full URLs, OAuth state/transaction, problem detail/instance, or exception text. HTTP status is bounded to integer 100..599. Unreadable HTTP and aborted browser operations remain distinguishable without raw exceptions.
- Correlation validation checks length before regex; 32-hex and 36-character canonical forms preserve wire representation. Oversize/trailing-newline/URLs are rejected, not truncated. Correlation is still sensitive linkability metadata; the visible copy warns against public posting.
- Realm is selected only from the two exact source-owned Login hosts; unknown hostnames never enter JSON. Build provenance is supplied by `GITHUB_SHA` in the existing hosted build, not browser input. Operation follows the actual password/context/Passkey/navigation boundaries, without exposing private account subreasons.
- The change does not alter server API, authentication payload semantics, generic 401 response shape, retries or navigation destinations. Existing error text is deliberately preserved. Consequently **receipt privacy is not a claim that all existing visible error messages are universally sanitized**: `errorMessage` still renders the existing Error message outside the receipt. This is pre-existing behavior, not a newly copied/uploaded exception.
- Native closed details/summary, explicit type=button copy, text-node JSON rendering, selectable pre, localized polite status and catch/finally for clipboard rejection provide coherent progressive disclosure and no credential resubmission. No fetch/upload/storage/logging was added to the receipt/control. Runtime screen-reader and visual layout verification remain unperformed.
- Existing hosted Login frontend job runs workspace `vitest run`, and new tests use normal `*.test.ts` placement under `src`; there is no exclusion config. happy-dom is already a locked root dependency. Tests cover receipt boundaries and synthetic DOM integration, but their identical generic 401 fixture comparison is **not** a server anti-enumeration test. The server code is unchanged, so no server behavior should be inferred from that fixture.

## Optional hardening, not a release blocker

`support-receipt.ts` build-revision regex uses JavaScript `$`, so a synthetic 40-hex revision plus final newline can pass. Unlike correlation input, this value comes from trusted hosted `GITHUB_SHA`, so no browser-controlled disclosure path exists. A length==40 guard and newline regression case would make the documented strict 40-character invariant exact for arbitrary direct helper calls. No production fix is required to unblock hosted checks.

Further inexpensive hosted fixtures could cover Passkey start/HTTP completion and post-auth navigation failure attribution; current source inspection confirms those assignments, but existing integration cases do not exercise every operation.

## External constraints

- OWASP Authentication Cheat Sheet, Authentication and Error Messages: preserve generic outcomes to avoid account enumeration. https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-and-error-messages
- MDN HTML details: native details/summary represents a disclosure widget. https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details

This small review does not need a speculative research-driven redesign: finite projection rather than error-object redaction is the concrete privacy boundary.

## Narrow follow-up closure

Reviewed fix `78b6af6` against `d682167` by source diff and `git diff --check`. The receipt now requires `revision.length === 40` before the 40-hex regex, closing the optional terminal-newline mismatch. New hosted regression cases cover LF, CRLF, 39-character and 41-character revisions. No additional substantive defect found; the earlier optional revision note is resolved. This is source-only closure, not a claim that these tests have executed. The GO remains limited to hosted source checks; original 401/live rollout remain outside this review.
