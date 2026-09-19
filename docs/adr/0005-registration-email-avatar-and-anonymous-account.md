# ADR-0005: Registration Email Step, Avatar Normalization, and Anonymous Account Landing

- Status: Accepted
- Date: 2026-09-19
- Owners: Login, Account, and Identity
- Scope: the three user-facing gaps reported after ADR-0004
- Supersedes: only ADR-0004's explicit deferral of automatic verification during registration; ADR-0004's verification transaction, delivery outbox, limits, and failure semantics remain authoritative

## Context

The backend already supports bounded, single-use email verification and the Account UI can run it. Both password and Passkey registration nevertheless create an unverified primary email and then render registration success. This makes a deliberately deferred capability look absent.

The Account application also renders an unauthenticated request as an error card inside an otherwise empty private dashboard shell. Avatar selection uploads immediately, without showing the bytes that will be published or reducing an unnecessarily large source image. The Identity upload handler validates signatures and dimensions, but currently stores source bytes unchanged; client-side processing must therefore never be treated as a trust boundary.

## Decision

### 1. Email verification is part of the registration journey

Keep the existing account-first model and the ADR-0004 state machine. After either registration method creates the account and Identity session, Login selects the new primary email identifier, starts the existing contact-verification transaction, and presents the eight-digit code form. Registration success and the Account navigation action are not presented until completion succeeds.

```text
credentials/passkey -> account + session -> verification start -> code entry -> verified -> success
                                                ^                  |
                                                `------ resend ----'
```

This is a product-flow requirement, not a claim that account creation, an external mail provider, and inbox delivery are one transaction. A provider outage leaves a usable authenticated recovery point: the UI remains on the verification step and offers bounded resend/retry. It must not resubmit registration and turn a delivery incident into a username conflict.

The two registration methods converge on one Login-side verification coordinator. Password registration proceeds directly to it. Passkey registration must continue to expose one-time recovery codes before they can be discarded; its acknowledgement action advances to verification rather than directly to Account. Verification start/completion, cooldown, hourly limit, expiry, wrong-code lockout, destination binding, uniqueness, encrypted outbox, idempotency, and at-least-once delivery remain exactly as defined by ADR-0004.

This decision does **not** introduce a `pending` principal lifecycle state or a second pre-registration challenge system. If policy later requires “no principal or session exists before mailbox proof,” that is a different authority model and requires its own migration and ADR.

### 2. Anonymous Account is a first-class presentation state

Retain the existing discriminated session union (`pending | anonymous | authenticated`). `anonymous` is a normal product state, not an error and not a new business route. It renders a dedicated, full-width landing page with the existing warm editorial theme, concise descriptions of profile/security/session/grant management, and two actions:

- sign in while preserving the normalized Account deep link; and
- create an account at the environment-paired Login origin.

Private sidebar/bottom navigation and user controls do not render in the anonymous layout. Locale, theme, reduced-motion behavior, visible focus, mobile layout, and the shared brand assets remain available. A `401` still performs the current atomic transition to `anonymous`; only unexpected failures render an error state.

### 3. Preview the normalized avatar, not the source file

Login and Account use one shared browser image-preparation module. Selection no longer uploads immediately. The normal flow is:

```text
select -> decode -> orientation-aware center crop -> bounded downscale -> encode
       -> preview the encoded Blob -> explicit confirm -> upload
```

The initial output policy is a square image no larger than 1024 x 1024, never upscaled, encoded as WebP at a visually reviewed quality near `0.86`. The implementation checks the actual encoder result and uses a documented supported fallback rather than relabeling bytes. It applies a decoded-pixel budget independently of the transport-byte limit. Replacing, cancelling, completing, aborting, or leaving the page revokes every preview object URL. The API client uploads the prepared `File`, and its response type is the OpenAPI `Avatar` resource.

The preview must use the prepared Blob so it truthfully shows crop and compression. Source dimensions, output dimensions, and output size are visible before confirmation. Decode/encode failure preserves the current avatar and offers reselection; it never silently publishes the unpreviewed source.

Browser normalization is a bandwidth and UX optimization, **not validation**. Identity continues to distrust the filename, declared media type, dimensions, and encoding. Before the service can claim metadata removal or canonical media, the authoritative upload pipeline must decode and re-encode the submitted bytes (prefer the Cloudflare Images binding over embedding a large codec in the Worker), compute digest/size/dimensions from that canonical output, and only then publish the immutable R2 object. Until that server step ships, contracts and UI must not claim that the server stripped metadata.

## Ownership and interfaces

| Boundary | Owns | Must preserve |
| --- | --- | --- |
| Login | Registration verification coordinator, recovery-code acknowledgement, registration avatar preview | Existing Identity session/CSRF cookies; no verification secrets in URLs or persistent storage |
| Account | Anonymous landing and account avatar confirmation UX | Deep-link return URI, session union, authenticated dashboard behavior |
| Frontend shared package | Decode/crop/downscale/encode result and preview disposal contract | Abortability, object-URL cleanup, deterministic bounds |
| Identity | Contact verification authority and authoritative avatar validation/canonicalization | ADR-0004 state machine, D1/R2 pointer invariants, RFC 9457 errors |
| D1/R2 | Verification/outbox facts and immutable current-avatar metadata/object | One pending email challenge per contact; one current ready avatar per principal |

## Failure and concurrency semantics

- Refresh or navigation after account creation never retries account creation. An authenticated user can resume verification through the existing Account contact flow; a resend always creates a new bounded attempt and invalidates the prior pending code according to ADR-0004.
- Wrong or expired codes retain the verification form and stable problem handling. Resend replaces the transaction ID used by subsequent completion.
- Avatar preparation is local and side-effect free. Only confirmation performs the mutation. Double confirmation is disabled in the UI, but server idempotency remains the authority for network retry.
- R2 and D1 do not become a distributed transaction. A new canonical object is written first, the D1 current pointer changes atomically, and failed pointer changes compensate or leave observable cleanup work, as in the existing avatar lifecycle.
- Existing authenticated Account routes and the public Identity HTTP protocol keep their URLs. The registration flow consumes existing verification endpoints rather than creating a parallel contract.

## Acceptance criteria

1. Password and Passkey registration both automatically enter the email-code journey; only verified completion exposes the final Account action.
2. Passkey recovery codes remain visible once and require acknowledgement before progression; email delivery failure cannot erase them or recreate the account.
3. Start, resend, invalid code, expiry, lockout, contact conflict, provider backlog, and success are covered without bypassing ADR-0004 limits.
4. An anonymous Account visit shows a responsive localized landing page, no private navigation, working sign-in/create-account CTAs, and preserved deep-link return.
5. Selecting an avatar shows the actual normalized output and does not upload until confirmation; cancel/reselect/abort revoke previews and leave the current avatar unchanged.
6. Landscape, portrait, square, transparent, corrupt, over-pixel-budget, and small images have deterministic tests. Small images are not upscaled.
7. Identity still rejects unsupported or malformed bytes independently of the browser. Any release claiming metadata stripping includes a server decode/re-encode test and verifies D1/R2 metadata against output bytes.
8. Login, Account, shared frontend, OpenAPI, Rust, and fresh-migration CI remain green; staging smoke covers real email-provider acceptance and an avatar round trip without exposing message or image secrets in logs.

## Evidence

- The existing bounded email authority and delivery design is recorded in [ADR-0004](0004-email-verification.md).
- Cloudflare's Images binding accepts raw image bytes and supports explicit transform/output chains: [Optimize with Workers](https://developers.cloudflare.com/images/optimization/binding/).
- Canvas encoding produces a Blob, and object URLs must be revoked when no longer needed: [MDN `HTMLCanvasElement.toBlob()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob).
- OWASP recommends single-use, time-limited email proof and consistent normalization across registration and login: [Email Validation and Verification Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html).

