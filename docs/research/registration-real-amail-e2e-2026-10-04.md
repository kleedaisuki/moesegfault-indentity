# Real Registration via amail (2026-10-04)

## Scope and environment

Staging-only UI exercise of revision d3e16b3, using native Codex browser and installed
amail 0.1.2. Mail operations were limited to an existing active owned test address
and the received registration message. No Outlook test message was sent. No
production Identity account was created by this test. The amail authorization
itself uses its existing production Identity realm, independently of staging.

## Observations (Asia/Singapore)

- The saved amail session reported authenticated but refresh failed with HTTP 400.
  The CLI cleared the invalid session. Normal `amail login` completed successfully;
  existing address reuse avoided provisioning another alias.
- Actual registration mail arrived at 00:07:40 via amail. Search selected only the
  test recipient and recent time window; read/unpack retrieved the real mail.
  The actual eight-digit code was entered into the inline form and accepted.
- Final password registration succeeded around 00:10. Account Center displayed
  username `staging_e2e_20261003`, display name `Staging 闭环测试`, and a primary
  email with verified state. Profile drafts remained through email confirmation.
- A logout navigation produced ERR_BLOCKED_BY_CLIENT in the browser. Later real
  password login succeeded around 00:18. The sessions page showed the original
  00:10 session revoked at 00:14 and the new 00:18 session as current. This confirms
  account credentials work and the old session is revoked, but is not evidence
  that logout redirect presentation is clean in this browser.
- Browser click/screenshot operations intermittently failed or timed out; keyboard
  activation worked. Registration avatar upload did not complete. Do not report
  real avatar persistence or Passkey registration as tested.

## Discovered product defect

The submitted status message and interests were absent from the Account profile
form. Registration code sends these fields (`apps/login/src/pages.ts`) and the
password handler has an INSERT into `account_profile_details` (`password.rs`).
The account repository's AccountView and account SELECT omit these details, and
`/v1/me` projects only display name, avatar URL and locale (`api.rs`). This explains
missing readback, but no direct database read was performed; successful INSERT
cannot be independently asserted from browser evidence alone.

Follow-up: join the optional profile-details row into the account read model and
project its fields through the existing profile contract. Add a real Worker test
that registers status/interests and reads them through `/v1/me`, then repeat the
UI profile readback. Do not paper over missing server data using local drafts.

## Privacy and retained state

The first-use automatic OpenRouter indexing disclosure was given before mailbox
use. No password, OTP, OAuth token, full mail address or raw body is recorded here.
Retrieved message files were kept under repository `.temp` and removed after use.
Mail reads did not mark or delete server messages. The staging test account remains;
no credential was committed. The browser is left on its sessions page.
