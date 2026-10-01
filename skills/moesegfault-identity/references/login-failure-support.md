# Login failure support and safe attribution

Read this only for a naturally occurring Login failure or when changing its support UI. It is not a credential-debugging API or permission to reproduce a user's sign-in.

## Ask for the opt-in receipt, not the browser session

On the ordinary password or Passkey sign-in failure card, the user can expand **Support details** (**支持诊断信息**) and select **Copy diagnostic** (**复制诊断信息**). If clipboard access fails, the JSON remains selectable for manual copying. The section is closed by default; expanding it does not submit credentials or upload anything. Registration, recovery, and Passkey enrollment pages are outside this receipt's scope.

Ask the user only for that receipt through an established **private, trusted support channel**. Do not request a password, identifier, cookie, browser-storage export, HAR/network dump, full screenshot containing URLs, OAuth authorization/resume URL, transaction handle, code, or token. Correlation IDs are not bearer credentials, but can link a sensitive interaction; do not post the receipt in public issues. If no receipt exists, do not substitute raw browser data or ask the user to trigger another credential attempt merely to obtain one.

The receipt is ephemeral and user-controlled: no automatic upload, console logging, browser storage, diagnostic lookup API, or retry is added. The copied JSON is an allowlisted summary, not a serialized error or request:

| Field | Bound and interpretation |
| --- | --- |
| `schema` | Currently `1` |
| `revision` | Frontend build's 40-hex revision, otherwise `unknown`; not proof of the Identity API's serving revision |
| `realm` | Fixed Login-host mapping to `production`, `staging`, or `unknown`; not a user-provided issuer |
| `operation` | `browser_context`, `password_authentication`, `passkey_start`, `passkey_completion`, or `oauth_resume`; the boundary entered before failure, not a private credential subreason |
| `transport` | `http_problem`, `network_or_cors`, `aborted`, or `unexpected`; `network_or_cors` does not prove a specific CORS defect |
| `status` | Optional integer HTTP status in 100–599; absent when no readable HTTP outcome exists |
| `problem` | `authentication_failed`, `invalid_request`, `rate_limited`, `internal_error`, `network_error`, `transaction_expired`, `not_authenticated`, or `forbidden`; every other value becomes `unknown`, with no raw detail or provider body |
| `correlation` | Optional validated UUID, either 32 hexadecimal characters or canonical 36-character form; malformed values are omitted, never truncated |
| `observed_minute` | UTC observation time rounded down to the minute |

Unknown or absent fields are evidence limits, not invitations to collect secrets. Use the realm, revision, operation, readable status/problem, and optional correlation to select the responsible layer. Verify the deployed API revision separately when needed; do not assume a source change or a frontend revision proves a backend rollout.

## Keep the three failure/success layers separate

The Login heading `Sign-in wasn't completed` is shared presentation, not a protocol diagnosis.

| Observation | Meaning and next boundary |
| --- | --- |
| Password operation, `401 authentication_failed` | Generic pre-authentication rejection. Unknown/unverified identifier, inactive principal, password mismatch, and credential replacement can share this outcome. Do not infer or probe account existence, weaken verification policy, or blindly retry. Production and staging accounts are not interchangeable. |
| Password operation, `400 invalid_request` | May be an invalid/expired authorization transaction. The receipt deliberately omits raw detail, so this status/code alone does not prove that subcase; correlate privately with authorized, bounded server evidence. |
| Successful authentication followed by bad OAuth resume navigation | Continuation defect, distinct from the pre-authentication `401`. Password and Passkey responses must supply the same absolute, fixed-issuer resume URI; a root-relative URI resolved against Login can leave authentication complete but authorization unfinished. Do not fix this by collecting credentials in a relying party or broadening CORS. |
| A native CLI's loopback `Login complete. You may close this tab.` page | Application-owned callback presentation after browser authorization, not the hosted Login failure card. In amail this HTML is embedded in the CLI binary; improving it requires the corresponding CLI version, not an Identity-only deployment. |

The support-receipt deployment improves safe attribution of the next naturally occurring failure. It does **not** establish that the originally reported generic authentication rejection is fixed. A resume correction also cannot establish that. Preserve this distinction in incident notes and user-facing progress.

## Implementation evidence

The bounded receipt implementation was merged and deployed at Identity main `ef642619140928e3ab5603c575c45802dbeee370` (2026-10-01). Follow the source and focused review below for the exact allowlist and verification boundaries; do not copy an entire endpoint catalog into the Skill.

- [Receipt constructor and allowlist](https://github.com/kleedaisuki/moesegfault-indentity/blob/ef642619140928e3ab5603c575c45802dbeee370/apps/login/src/support-receipt.ts).
- [Opt-in support control](https://github.com/kleedaisuki/moesegfault-indentity/blob/ef642619140928e3ab5603c575c45802dbeee370/apps/login/src/ui/support-details.ts).
- [Scope, privacy contract, and test design](https://github.com/kleedaisuki/moesegfault-indentity/blob/ef642619140928e3ab5603c575c45802dbeee370/docs/research/login-failure-support-receipt-2026-10-01.md).
- [Hosted rollout and independent live delivery evidence](https://github.com/kleedaisuki/moesegfault-indentity/blob/455dbe3cd0034c166a9e22fd690694b7d6e83f29/docs/research/pr22-login-receipt-rollout-2026-10-01.md): delivery markers and anonymous checks are not authenticated UI or original-user incident proof.
- [First-party client contract](first-party-clients.md) for ceremony, CSRF, and OAuth navigation changes.
