# Optional Login failure support receipt

Date: 2026-10-01. Base: Identity main `08576c0549c3ab8d6b8b90f0fb6591b59962f5dd`.

## Scope and contract

The ordinary Login password and Passkey failure cards now have a closed native `details`/`summary` control. Expanding it reveals an ephemeral, selectable JSON receipt. Clipboard transmission occurs only after the explicit **Copy diagnostic** button, never during render, expansion, success, or background activity. There is no upload, local/session storage, console logging, new API, account lookup or auto-retry. Existing server status codes and generic failure text remain unchanged. Registration, recovery and enrollment pages are deliberately not covered by this bounded change.

The fresh receipt contains only schema `1`, immutable build revision (40 hexadecimal characters or `unknown`), fixed production/staging realm (other hosts become `unknown`), public operation enum, transport class, valid HTTP status, finite problem-code allowlist, optional validated correlation UUID and time rounded down to the UTC minute. No raw hostname, URL, error object/message, Problem Details detail/instance/extra fields, credentials, identifier, cookies, OAuth values or account subreason can enter through serialization. UUID-simple 32-hex and canonical 36-character forms are preserved exactly; other lengths and characters are omitted, not truncated. Newlines are rejected even though JavaScript's `$` anchor can match before a terminal newline.

The operation advances before each awaited public boundary: browser context, password authentication, Passkey start, Passkey completion (including browser ceremony), and post-authentication navigation. A receipt does **not** classify why a generic 401 occurred. Different private account-existence/verification/password branches remain intentionally indistinguishable. A browser abort is distinct from an unreadable network/CORS failure. Non-HTTP exceptions have no status field. `TypeError` is a conservative unreadable network/browser category, not proof of a specific CORS policy failure.

The Login Vite configuration embeds `GITHUB_SHA` available in the existing GitHub Actions frontend build step; no workflow or deployment settings change. Local/preview builds use `unknown`. The browser validates the value before including it. Production and staging remain fixed source-owned host mappings; configuration/query parameters cannot select the receipt realm.

## UI and support handling

Native `details` and `summary` provide normal browser keyboard interaction. The button is `type=button`, preventing accidental credential resubmission. Copy result is a localized polite status, not a replacement of the authentication error. Clipboard unavailability/rejection leaves the selectable text and original error intact. All three existing locales have complete copy. The control warns against publishing correlation IDs: these are not bearer credentials, but can link a sensitive interaction and belong in restricted support channels.

## Verification boundary

Synthetic Vitest cases added under the existing hosted Login frontend job cover HTTP 400/401/403/413/429/500, malformed problem JSON/type, network failure, abort, unknown error, hostile response/form/URL markers, both UUID formats and invalid/oversized/newline correlation values. DOM tests cover closed native controls, no automatic copy, explicit clipboard copy and rejection in all locales. Fresh-module Login integration fixtures cover 401/413 generic text, operation attribution, browser-context failure without credential submission, no retries/navigation on rejection, and no receipt after success.

Only static TypeScript AST parsing and `git diff --check` are permitted locally for this change. Project tests, typechecking and builds must run in GitHub Actions. No hosted result or live rollout is claimed by this document until independently recorded. No provider request or real credential attempt is needed to validate this layer. The original user authentication failure remains unproven/resolution-open; this receipt improves the next naturally occurring failure's safe attribution, not credential correctness.

## Related evidence

- [Pre-authentication diagnosis and safe discriminator](preauth-401-diagnosis-2026-10-01.md).
- [OWASP authentication failures](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-and-error-messages): preserve generic outcomes and avoid account enumeration.
- [OWASP logging exclusions](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude): exclude credentials, tokens and session secrets; the receipt is stricter and opt-in.
