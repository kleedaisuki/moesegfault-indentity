# Device sign-out appeared to do nothing

## Cause

The Account sessions page ignored `revoked_at`, both in its TypeScript projection and
its rendering. Identity deliberately returns active sessions **and sessions revoked
within the last 30 days** (`account_repository::sessions`). After a successful DELETE
and refresh, the revoked row therefore looked identical and retained a sign-out button.
Repeated sign-out is idempotent on the server, making further clicks appear ineffective.

This is a reproduced frontend contract mismatch, not evidence of a failed production
revocation. No live account or production session was modified during investigation.

## Resolution

- Add optional nullable `Session.revoked_at`, matching the existing server wire response
  while remaining compatible with older responses that omit it.
- Render revoked rows as localized signed-out history, including revocation time,
  instead of offering an action on an already-revoked session.
- Preserve the current-device badge, active remote-device actions, CSRF proof,
  cookie-authenticated requests, idempotency keys, and server-authoritative refresh.
- Expose the signed-out badge with `role="status"`. W3C's
  [status-message guidance](https://www.w3.org/WAI/WCAG21/Understanding/status-messages)
  supports programmatically identifiable action results.
- Do not change backend history retention or revocation semantics to conceal a UI bug.

## Validation

`apps/account/src/sessions.test.ts` exercises DOM clicks through the actual
`AccountApiClient`, using a fake HTTP service that retains revoked history just as
Identity does. It covers existing history, successful DELETE followed by rereading
history, repeat clicks while pending, refresh persistence, transport failure and retry,
current-device preservation, and a legacy response omitting `revoked_at`.

Before the fix, 3 of these 4 tests failed: revoked rows still offered sign-out, and
successful clicks/retries never produced signed-out feedback. After the fix:

- `npm run test:account`: 12 files, 55 tests passed.
- `npm run build:account`: TypeScript project build and Vite production build passed.
- `git diff --check`: passed.

The HTTP fixture does not execute the Rust Worker or prove deployed production behavior.
This change is frontend-only and has not been deployed as part of this repair.
