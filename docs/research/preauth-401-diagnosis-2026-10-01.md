# Pre-authentication 401: boundary diagnosis and safe next discriminator

Date: 2026-10-01. Inspected source: Identity main `08576c0549c3ab8d6b8b90f0fb6591b59962f5dd` (PR #19 merge). This investigation used static source and existing evidence; it did not submit credentials, perform a live login, query account records, mutate provider settings, run local project tests/builds, or collect private request/response bodies.

## Conclusion

The reported `Sign-in wasn't completed / Authentication failed` must not be declared fixed by PR #19. The known password OAuth resume defect happens **after successful password authentication**, whereas `401 authentication_failed` is a generic authentication rejection. The screen title alone is not a route discriminator: `apps/login/src/pages.ts` uses the same `loginFailed` title for password, Passkey and other failures. If the historical observation genuinely identified the password endpoint and 401, the following source map applies; if it identified only the screen text, that missing route/status remains the first uncertainty.

There is no evidence that the original user supplied an incorrect password. There is also no evidence of an original-user credential corruption or credential-version race. Successful synthetic staging authentication establishes a working path for that synthetic principal and realm, not the original account or production credentials.

The smallest useful next step is **a passive, allowlisted browser support receipt for the next naturally occurring failure**, tested first with injected responses in hosted CI. It requires no replay, credential capture, account lookup, public debug API, or new login attempt by an agent. It can separate protocol/context/service failures from generic credential rejection while intentionally not separating existing from nonexistent accounts.

## Exact source decision map

`crates/identity-worker/src/password.rs::authenticate` processes `POST /v1/password/authentications` in this order:

| Boundary | Source response | Meaning and limitation |
| --- | --- | --- |
| Browser mutation/CSRF validation | 403 `invalid_request`, `Invalid browser request context` | Cookie/CSRF/origin context failure; not this handler's 401 credential response. Missing secret/infrastructure errors can instead reach 500. |
| JSON parsing | 400 `invalid_request`, `Invalid JSON request` | Payload cannot be deserialized. |
| Password exceeds 128 Unicode scalar values | 401 `authentication_failed` | Generic rejection before identifier lookup. Registration accepts 15–128 scalar values; not evidence this happened. |
| Identifier lookup / password proof / lifecycle | 401 `authentication_failed` | Unknown or invalid identifier, contact not verified, passwordless principal, inactive principal, wrong password, or verification failure. Deliberately indistinguishable publicly. |
| Attempt throttle | 429 `rate_limited` plus `Retry-After` | Separate from 401; admitted attempts use a principal-shared or keyed unknown-identifier bucket. |
| OAuth transaction validation after correct proof | 400 `invalid_request`, `Invalid authorization transaction` | Unknown/non-awaiting/expired OAuth transaction, after credential proof. Not 401. |
| Credential authority lost before atomic session insert | 401 `authentication_failed` | Expected FK failure plus recheck confirming observed credential no longer current; preserves security during password rotation/recovery. |
| Unrelated DB/batch/internal failure | 500 generic internal problem | Source intentionally does not convert every FK failure into a wrong-password result. |
| Authentication success | 200 with session and optional absolute issuer resume URI | PR #19 corrected this resume origin. Local amail success HTML is a separate CLI binary boundary. |

The lookup joins `identifiers`, `principals`, and `password_credentials`, permits username or **verified** email/mobile only, and requires an active principal for success. `identity-domain/src/policy.rs::LoginIdentifier::parse` chooses email for `@`, mobile for a leading `+`, username otherwise. Username normalization is case-insensitive; email normalization preserves local-part case and lowercases the domain. This can surprise users who think every email address is fully case-insensitive, but no original input was inspected, so do not attribute this incident to case. Changing stored normalization is an Identity compatibility decision, not an amail-local workaround.

`verify_password` returns `false` both for an invalid encoded PHC hash and any Argon2 verification error. Thus a malformed persisted hash could surface as the same 401 as a mismatch. Registration uses the same Argon2 implementation to create hashes; no corrupt stored row was observed. A future server-only integrity alarm may classify malformed storage, but must not put that distinction in the anonymous response or support receipt.

## Existing evidence and its scope

- `docs/incidents/2026-09-29-password-oauth-resume-origin.md`: synthetic staging account registration/verification and password authentication succeeded; resume navigation wrongly used Login origin; issuer-rooted correction led to successful native PKCE and Mail authorization. This is evidence against a universally broken password handler, not original-user incident closure.
- `scripts/tests/password-security.mjs`: existing hosted isolated real-Worker harness seeds synthetic authority, validates password/session rotation and issuer-rooted OAuth continuation. `scripts/tests/password-rate-limit.mjs` exercises actual throttle and session authority SQL. These do not replay the user's failure.
- `apps/login/src/api/client.ts::ApiError` already preserves status, problem type and `x-moesegfault-correlation-id`; `lib.rs::finalize_response` exposes that response header to trusted browser origins.
- `apps/login/src/ui/dom.ts::errorMessage` projects an Error to only `message`; the screen therefore loses a useful correlation ID that already exists in the typed client. This is a confirmed supportability gap, not proof of bad authentication logic.
- Production PR #19 deployment monitoring is recorded separately in `docs/research/pr19-production-rollout-2026-10-01.md`; deployment success is not successful original-user password proof.

## One proposed discriminator: passive failure support receipt

Implementation proposal only; nothing in this document asserts it is shipped.

On a naturally occurring Login failure, add a collapsible `Support details / Copy diagnostic` affordance alongside the generic message. Construct a new object from an allowlist rather than serializing Error, Problem Details, Fetch options, `location`, form values or browser storage:

- schema version;
- build revision (build-time constant);
- realm from fixed trusted configuration (`production` or `staging`), not a query parameter;
- operation enum (`browser_context`, `password_authentication`, `passkey_start`, `passkey_completion`, `oauth_resume`);
- transport class (`http_problem`, `network_or_cors`, `aborted`, `unexpected`);
- HTTP status when available;
- problem code mapped through a finite allowlist, with all others `unknown`;
- server-generated correlation ID only if bounded and UUID-valid, otherwise omit;
- observation time, rounded to the minute.

No password, identifier, account/principal ID, contact verification state, existence flag, cookie, CSRF value, idempotency key, OAuth transaction/code/token/state/nonce, query/fragment, complete URL, raw response, raw exception message, or high-resolution timing belongs in the receipt. Do not upload it automatically or store it in analytics by default. Correlation IDs are not bearer credentials but still link an interaction: keep them in the user's opt-in copy and restricted incident handling, not public issues. Do not introduce an anonymous diagnostic lookup endpoint.

This yields a discriminating decision without account enumeration:

| Receipt | Next action |
| --- | --- |
| password_authentication / 401 / authentication_failed | Keep generic credential rejection. Confirm correct realm via fixed receipt metadata; offer username or previously verified contact and normal recovery/Passkey options uniformly to everyone. Never claim the account exists or password was wrong. |
| password_authentication / 400 / invalid_request | Investigate protocol transaction/payload boundary, not password recovery. A code alone cannot distinguish the two 400 titles; restricted protocol instrumentation may be needed. |
| password_authentication / 403 | Inspect browser context integration and trusted origin pairing. |
| 429 | Respect `Retry-After`; do not auto-retry credentials. |
| 500 | Restricted internal failure investigation using correlation, not request capture. |
| network_or_cors | No readable HTTP problem was observed; do not label it a credential rejection. |
| passkey operation | Investigate that ceremony, not the password resume branch. |

Receipt alone cannot split the intentionally generic 401 branches. That is a deliberate privacy boundary, not an inadequately thorough test. Exact user-account diagnosis requires a separate, authorized Identity support process; do not invent privileged account inspection for amail.

### Hosted verification before exposure

Extend the existing Login API and page tests in GitHub Actions, not locally. Inject synthetic Fetch outcomes with no real account or credentials: 401, 400, 403, 429, 500, malformed problem JSON, network rejection, abort, missing/malformed/oversized correlation headers, unknown problem type, and synthetic secret markers in `detail`, URL, exception text and input fields. Assert the receipt includes only allowed fields, never markers, uses the correct operation, and never navigates/resubmits on rejection. Assert equal 401 receipt shape and generic copy for synthetic known/unknown-account cases. Also verify keyboard access and copy support failure do not erase the original error. No Worker deployment, account creation or live credential proof is necessary for this first discrimination layer.

## External grounding

[OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-and-error-messages) recommends indistinguishable authentication failures across incorrect credentials, nonexistent and disabled accounts, including attention to status/timing differences. This supports retaining generic 401 rather than exposing lookup subreasons. Its email-login discussion also assumes verified contacts.

[OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#event-attributes) supports interaction correlation and outcome/status fields, while [its exclusion guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude) excludes passwords, tokens, session identifiers and unnecessary PII. The proposed receipt applies a stricter allowlist than a general logging checklist. These are primary security practice references, not evidence that the original user failure is resolved.
