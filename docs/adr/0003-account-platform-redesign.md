# ADR-0003: Account Platform Redesign

- Status: Accepted
- Date: 2026-09-15
- Supersedes: the passkey-only and Login-hosted account-management portions of `login-identity-design.md`
- Scope: target architecture and implementation order; machine contracts remain authoritative in OpenAPI

## Context and evidence

The repository currently has one Rust `identity-worker`, a static `login` SPA, one D1 database, an R2 audit archive, OpenAPI 3.1.1, and GitHub Actions delivery. The original design made passkeys mandatory and put profile, credential, binding, and session management under `login.moesegfault.dev`. Work in progress now also contains a static `account` SPA which calls Identity directly; it is **not yet a Backend for Frontend (BFF)**.

That shape has three product defects:

1. It makes a relatively new authenticator the admission requirement instead of an optional, better sign-in path. A 2026 field study let 5,057 users choose passkey or password plus 2FA and found that less-experienced users still struggled with passkey adoption. A separate 2026 census found major inconsistency in passkey management across sites. These results support coexistence and consistent management, not passkey-only onboarding. They do not show that passwords are intrinsically preferable. [IEEE field study](https://ieeexplore.ieee.org/document/11573563/), [USENIX Security 2026](https://www.usenix.org/conference/usenixsecurity26/presentation/jannett), [SOUPS 2026](https://www.usenix.org/conference/soups2026/presentation/ramat)
2. Authentication ceremonies and ongoing account administration have different user intent, navigation, failure modes, and release cadence. Combining them makes `login` a miscellaneous identity portal.
3. The profile is too thin for an anime-oriented community, while the protocol surface is not explicit enough for other services to integrate without bespoke session sharing.

The redesign is greenfield: no compatibility with the old implementation is required. Protocol conformance and safe version skew between newly deployed components are still required.

## Decision summary

Adopt **one authority, three web experiences**:

```text
Browser / native app
   |-- login.moesegfault.dev   authentication, registration, recovery ceremonies
   |-- account.moesegfault.dev profile/security/privacy administration
   `-- application BFF        local application session
                 | OAuth 2.0 / OpenID Connect
                 v
        identity.moesegfault.dev
        principal + account + authenticator + session + OAuth authority
                 |-- D1 authoritative relational facts
                 |-- R2 immutable avatar objects and audit archive
                 `-- Queue/outbox -> email/SMS and telemetry adapters
```

`login` and `account` are presentation products, not competing identity authorities. Identity owns every principal, login identifier, contact point, authenticator, account policy, identity session, authorization grant, and signing key. Business services own their roles and domain data.

The current direct-CORS static `account` SPA is an acceptable bootstrap only. The target is an Account BFF on the same origin as its static assets. The BFF is a confidential OAuth client, keeps tokens server-side, exposes a host-only session cookie, and calls Identity with narrow account-management scopes. RFC 10017 strongly recommends the BFF pattern for applications handling personal data and documents its cookie and CSRF requirements. [RFC 10017, OAuth for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc10017.html)

## Boundaries and ownership

| Component | Owns | Must not own |
| --- | --- | --- |
| Login UI/Worker | Identifier/password UI, passkey ceremony UI, registration, recovery, consent/step-up presentation | Account settings, tokens, D1 facts, business authorization |
| Account UI/BFF | Profile/contact/avatar/preferences/security/session/grant UX; BFF session and server-side tokens | Password verification, WebAuthn verification, OAuth signing, business roles |
| Identity Worker | Account and authenticator domain, OAuth/OIDC, verification state, audit/outbox | Product-specific profiles, community moderation, application roles |
| Application BFF | OAuth client, local session, resource authorization integration | Shared user passwords, global account state |
| Resource service | Its data and permissions | Authentication ceremonies or globally meaningful roles |

Other services do **not** call the Login UI as an authentication API. They discover and use the Identity issuer; Identity navigates the browser to Login when human interaction is required. Login may be unavailable while existing refresh-token and client-credential flows continue.

Account self-service deliberately dogfoods the same OAuth and resource API boundaries offered to first-party services. A future migration from the current static SPA is: introduce an Account BFF without changing Identity resources, move tokens/calls behind it, then remove direct credentialed CORS from `account`.

## Core data model

Use opaque UUID principal IDs internally. Do not use an email, mobile number, username, provider subject, or credential ID as the account primary key.

```text
principal 1--1 human_account 1--1 profile
    |                |          `--0..1 current avatar_asset
    |                `--1..* contact_point
    |--1..* login_identifier
    |--1..* authenticator --0..1 password_credential
    |                    |--0..1 webauthn_credential
    |                    `--0..1 totp_credential (future)
    |--0..* identity_session --1..* session_authentication_method
    `--0..* oauth_grant
```

Do not put every credential into one nullable row or an arbitrary JSON blob. `authenticator` is the lifecycle parent (`id`, `principal_id`, `kind`, label, state, timestamps); one kind-specific table carries its cryptographic fields. Database checks/triggers enforce exactly one subtype. This makes password, passkey, and future TOTP/push methods normal cases without weakening their different invariants.

### Account and persona

`human_account` carries lifecycle and policy revision. `profile` carries:

- required `display_name` and unique login `username`;
- optional avatar, short `status_message`, `bio`, `pronouns`, `favorite_character`, a bounded ordered set of interest tags, and bounded profile links;
- profile visibility (`private`, `members`, `public`), `locale`, IANA time zone, and `updated_at`.

The UI may present playful labels such as “adventurer name”, “dimension signature”, and “oshi”, but the API retains neutral stable field names. Age, legal name, address, government identity, school, and other speculative personal information are not collected. Badges, follows, moderation state, and application-specific fandom graphs belong to community services, not Identity.

Avoid unconstrained `interests_json` and `links_json` as long-term domain models. Expose typed arrays in the API and validate count, length, URI schemes, and a versioned tag vocabulary at the boundary; relationalize them if querying or referential integrity becomes necessary.

### Contacts and identifiers

`contact_point` records email/mobile display value, canonical value, primary flag, verification state, verification timestamps, and lifecycle. `login_identifier` maps a unique normalized username or **verified** contact point to a principal. Thus a contact is not silently granted login or recovery authority merely because it was collected.

Registration requires username, display name, email, and at least one chosen sign-in method. Password is the universal default; passkey is an alternative when capability detection succeeds and is also offered as an optional addition after password registration. Avatar and mobile are optional. The **site** always supports password and passkey even though an individual user may deliberately keep only one after recovery checks. Email may begin unverified, so a delivery outage does not roll back a usable newly created account. Email/mobile verification is a separate single-use transaction. Promoting a replacement primary contact and retiring the old one is one atomic mutation after verification.

Mobile input is country/region selector plus national number. The selector is searchable and defaults from locale only as a suggestion, never silently from IP. Normalize using maintained numbering-plan metadata, store the canonical global number in E.164 form plus the selected ISO region, and return an RFC 3966 `tel:` form where relevant. OIDC only emits `phone_number_verified=true` after affirmative verification. [RFC 3966](https://www.rfc-editor.org/rfc/rfc3966.html), [OIDC standard claims](https://openid.net/specs/openid-connect-core-1_0-18.html#StandardClaims)

### Avatars

Avatar bytes are immutable, randomly keyed R2 objects. D1 stores owner, digest, media type, dimensions, state, and which ready asset is current. Accept bounded JPEG/PNG/WebP/AVIF inputs, decode and re-encode before publication, strip metadata, create fixed variants, and never publish user SVG/HTML. Changing an avatar atomically changes the D1 pointer; orphan/pending objects are idempotently reaped later. A generated local placeholder keeps avatar optional.

## Passwords, passkeys, and future 2FA

### Password baseline

Password and passkey are peer sign-in choices. The login form provides:

1. username or verified email plus password;
2. a visible “Use a passkey” action; and
3. conditional passkey mediation on an appropriately annotated identifier input when capability detection succeeds.

Conditional mediation supplements the explicit action; it never hides password or becomes the only way to invoke a cross-device/security-key passkey.

Apply NIST SP 800-63B-4 password behavior: minimum 15 Unicode characters for password-only authentication; allow at least 64 characters and password managers/paste; use no composition or periodic-rotation rules; NFC-normalize without trimming; screen the entire candidate against common/compromised and context-specific values; rate-limit guessing without permanent account lockout. [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html#passwords)

Password storage is algorithm-agile. Persist a PHC-style encoded verifier or explicit algorithm/version/cost/salt fields and a pepper revision; keep peppers in Workers Secrets; rehash after successful authentication when policy changes; compute a dummy verifier for unknown identifiers; compare fixed-length results in constant time.

Argon2id is preferred. The initial practical candidate is the currently implemented 19 MiB, two-pass, one-lane profile, but it is **not accepted merely because it compiles**. CI/load qualification must measure latency, CPU, isolate memory, and concurrency on the paid Workers runtime. RFC 9106's memory-constrained profile uses 64 MiB, while a Worker isolate has 128 MB shared by WebAssembly and concurrent requests; blindly applying that profile risks availability failure. If a useful Argon2id cost cannot stay inside the password-endpoint SLO and memory headroom, switch new verifiers to calibrated PBKDF2-HMAC-SHA-256 through Workers WebCrypto, while continuing to verify and opportunistically migrate old records. The stored algorithm makes this a policy change, not a schema migration. [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers WebCrypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

### Passkeys and assurance

WebAuthn uses a narrow `rp.id = login.moesegfault.dev`, exact production origin, discoverable credentials, user verification, and `attestation=none` by default. A successful UV passkey is phishing-resistant and can satisfy the platform's higher assurance policy; do not claim a regulated NIST AAL solely from the word “passkey”. Preserve BE/BS, transport, AAGUID, and sign counter, but do not reject a synchronized passkey solely because its counter did not advance.

Account owns the “add/rename/remove passkey” workflow, list, and result. Because an `account.moesegfault.dev` document cannot safely perform ceremonies for the narrow Login RP, Account creates a one-shot management intent and performs a full-page redirect (or desktop progressive-enhancement popup) to Login for the ceremony, then returns to a fixed Account completion URI. Do not broaden the RP ID to `moesegfault.dev`; that would make every sibling subdomain part of the credential boundary. Full-page redirect is the reliable mobile baseline.

Each passkey is independently named, listed with creation/last-use/sync information, associated with sessions, and revocable. The 2026 WebAuthn Level 3 Recommendation defines conditional mediation and discoverable credential behavior. [WebAuthn Level 3](https://www.w3.org/TR/2026/REC-webauthn-3-20260825/)

### Factor policy and recovery

Model an authentication transaction as an ordered set of satisfied methods plus a policy snapshot, not one `auth_method` string. Store standards-compatible `amr` and a platform `acr` describing actual evidence. Phase one supports password and passkey alternatives. The subtype and policy model admits TOTP and hardware OTP later without pretending that an enrolled factor was used.

When a user enables “require a second factor after password”, password must be followed by TOTP or another qualifying method; a UV passkey may authenticate directly at the higher platform assurance. SMS is a verified contact/recovery channel, not the preferred 2FA factor. Recovery codes remain one-time, hashed, replace-on-use capabilities. Password reset links/codes are short-lived, single-use, bound to a recovery transaction, invalidate relevant sessions after completion, and generate a notification. High-risk contact, authenticator, recovery, and grant changes require recent higher-assurance reauthentication.

## OAuth/OIDC integration contract

Identity is the only issuer and publishes OIDC Discovery and JWKS. Support:

- Authorization Code + PKCE S256 for web/BFF/native human flows; exact registered redirect URIs, `state`, `nonce`, authorization-response `iss`, short one-use codes, and rotating refresh-token families;
- external system browser or platform browser tab for native apps, never an embedded WebView; claimed HTTPS redirect preferred, private-use or loopback redirects only for registered native clients;
- `private_key_jwt` for confidential clients; `none` only for pre-registered public native clients;
- Client Credentials with asymmetric client authentication for workload principals, issuing access tokens only (no human ID token);
- RFC 9068 JWT access tokens with `typ=at+jwt`, fixed issuer, audience, scopes, short expiry, and locally cached fixed-issuer JWKS; RFC 7662 introspection where immediate state is required; RFC 7009 revocation;
- pairwise `sub` per sector, explicit consent/grants, and minimal standard scopes: `openid`, `profile`, `email`, `phone`, `offline_access`; no global roles in tokens.

Discovery is the integration entry point. Publish a short service integration guide and generated clients, but do not invent a custom login SDK that conceals protocol behavior. Dynamic public client registration is deferred; clients, redirect URIs, keys, audiences, and scopes use a separately authorized control-plane API/deployment manifest.

These choices follow the current OAuth security BCP, OIDC Core, native-app external-user-agent BCP, and interoperable JWT access-token profile. [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0-18.html), [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html), [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html)

## API families and semantics

Maintain separate OpenAPI 3.1.1 documents/bundles for materially different audiences while sharing schemas:

| Surface | Representative resources |
| --- | --- |
| Protocol/discovery | `/.well-known/openid-configuration`, JWKS, authorize, token, userinfo, revoke, introspect, logout |
| Authentication | registration, password authentication, WebAuthn ceremonies, factor challenges, recovery, contact-verification transactions |
| Self-service account | `/v1/me`, profile, contacts, avatar, authenticators, factor policy, sessions, recovery codes, grants, preferences, export/deletion |
| Service/control plane | OAuth clients, keys, redirect URIs, audiences/scopes, registration policy; never exposed to ordinary account tokens |

Use plural resources, opaque IDs, UTC RFC 3339 timestamps, `snake_case`, explicit bounds, examples, scopes, complete response/status matrices, and RFC 9457 `application/problem+json`. OAuth endpoints retain their specified OAuth error shapes. Problem `type` and machine `code` are stable; localized `title/detail` are advisory and never parsed. [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html), [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)

Mutations accept an idempotency key and store caller + operation + key + request digest + result reference. Reusing a key with different input is `409`; replaying completed identical input returns the original logical result. Collections use bounded cursor pagination. Mutable account resources expose an ETag/version and accept `If-Match` so two Account tabs do not silently overwrite each other. Verification/authentication completions use database uniqueness claims and transactions, not read-then-write checks.

## Frontend, i18n, theme, and device behavior

Both sites pin and bundle an exact [`@moesegfault/style`](https://github.com/kleedaisuki/moesegfault-style) release. Production must not fetch `latest` CSS or depend on GitHub Pages at runtime. Use its semantic `--moe-*` tokens and locally bundled `brand.svg` and `sparkle.svg`; extend the shared style repository with a reviewed SVG icon set and a single accessible Icon component instead of embedding unrelated emoji or one-off SVG paths. Decorative icons are hidden from assistive technology; meaningful icon-only controls have localized accessible names.

Initial locales are `zh-CN`, `en`, and `ja`. Messages use Unicode MessageFormat, BCP 47 tags, CLDR/`Intl` formatting, and per-document `lang`/`dir`. Selection order is authenticated account preference, explicit non-sensitive locale cookie, `Accept-Language`, then `zh-CN`; every site exposes a visible selector. API stable fields and error codes are never translated. Locale completeness, unused keys, interpolation parameters, pseudo-localization, text expansion, and RTL layout are CI gates. [Unicode MessageFormat](https://messageformat.unicode.org/), [BCP 47 / RFC 5646](https://www.rfc-editor.org/rfc/rfc5646.html), [HTTP language negotiation](https://www.rfc-editor.org/rfc/rfc9110.html#name-accept-language)

Theme preference is `system | light | dark`, stored in the account and a non-sensitive host-only cookie for pre-auth pages. Render a tiny first-party bootstrap before paint, set `color-scheme: light dark`, then use style-system semantic tokens and `prefers-color-scheme`. Respect `prefers-reduced-motion`; do not make decorative motion part of authentication feedback.

Responsive behavior is built around one-column mobile forms, safe-area insets, the dynamic viewport, at least WCAG 2.2 AA target spacing, visible focus, correct `autocomplete` and `inputmode`, password-manager paste/autofill, no hover-only actions, and no horizontal scrolling at 320 CSS px. Account lists become labelled cards rather than clipped tables. Validate at 200% text zoom, keyboard-only operation, and screen readers. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

Do not guess capability from User-Agent. Feature-detect WebAuthn/conditional mediation. A constrained embedded browser receives a concise explanation and “Open in system browser” action while password remains usable when the environment can securely support ordinary web forms. OAuth-native clients must launch an external browser or a platform browser tab retaining browser security properties. Preserve the server-side authorization transaction across that handoff; never put tokens or raw return URLs in it. Cancel, timeout, background/foreground, and back-navigation resume to a deterministic retry screen rather than losing the transaction.

## Persistence, concurrency, and failure semantics

- Keep authoritative identity facts in one D1 database to preserve atomic uniqueness and credential/account transitions. D1 `batch()` commits sequential statements as one transaction; constraint failure rolls the batch back. Use the Sessions API with `first-primary` or a bookmark for correctness-sensitive reads when replication is enabled. [D1 batch and sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- The outbox row is committed with the account/audit mutation. A dispatcher publishes notification/audit work to Cloudflare Queues; consumers deduplicate by event ID because delivery is at least once. Provider calls never run in the authentication transaction. [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- Email/SMS, telemetry, avatar transformation, and audit archive outages create visible pending/backlog states and retries but do not take password/passkey sign-in down. Status/telemetry is never an authentication dependency.
- All state-changing completions are one-use and atomic. Contact replacement retains the old verified primary until the new contact is verified. Credential deletion cannot leave an account with no usable sign-in/recovery path. Recovery and password change rotate/revoke affected sessions and refresh families in the same logical operation.
- Frontends time out network requests, offer safe retry, and preserve only opaque transaction handles. Tokens, passwords, challenges, recovery codes, and provider credentials never enter URL, local storage, logs, metrics, analytics, or service-worker caches.

## Observability and SRE

Observability is a release requirement, not a post-launch dashboard task.

### Signals and privacy

Propagate W3C `traceparent` from edge-generated trusted context through Account/Login, Identity, D1/R2/Queue/provider calls. Emit OpenTelemetry-compatible resource attributes (`service.name`, environment, version/commit, Cloudflare script version) and stable route-template spans. Never use principal/contact/credential/transaction/correlation IDs as metric labels. Keep PII and request bodies out of normal logs/traces; security audit is a separate restricted dataset. [W3C Trace Context](https://www.w3.org/TR/trace-context/), [OpenTelemetry HTTP semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/), [Cloudflare Workers logs/traces](https://developers.cloudflare.com/workers/observability/)

Required low-cardinality metrics cover RED signals per route and method plus authentication outcome by method/reason class, password KDF duration and resource errors, token exchanges, D1 operations, queue/outbox age and depth, verification delivery, avatar pipeline, and deployment version. Distinguish user cancellation/invalid credentials from platform/server failure; otherwise a product funnel becomes a false availability SLI.

### Initial objectives

Use rolling 28-day objectives, reviewed after real baselines:

| User journey | Initial SLO / indicator |
| --- | --- |
| authorize + token protocol | 99.95% good server responses; token endpoint p95 <= 300 ms excluding intentional password KDF budget |
| begin/complete password or passkey auth | 99.9% platform completion; p95 server work <= 750 ms; exclude explicit user cancel, policy rejection, and invalid credentials |
| Account read/mutation API | 99.9% good responses; p95 read <= 500 ms and mutation <= 1 s, excluding uploads/provider delivery |
| notification outbox | 99% of accepted verification notifications handed to provider within 5 min |
| avatar processing | 99% of accepted assets ready/rejected within 5 min |

Alert with multi-window error-budget burn rates and page only on actionable service symptoms; create tickets for slow burn and capacity trends. A telemetry-backend outage is itself observed through an independent synthetic/dead-man signal and must not block users. [Google SRE burn-rate alerting](https://sre.google/workbook/alerting-on-slos/)

Run synthetic discovery/JWKS/token-validation probes from outside Cloudflare, browser journeys for Login/Account, and queue-age checks. Full synthetic human auth uses a dedicated non-privileged test principal and browser virtual authenticator in staging; production probes must not require a reusable human password in the frontend bundle. Every alert links a runbook, owner, dashboard, recent deployment, and rollback/mitigation action.

## GitHub Actions and rollout

Use one tested revision and build artifacts once. All third-party actions are pinned to full commit SHAs; permissions default to `contents: read`; production credentials exist only in a protected GitHub Environment. GitHub identifies full-SHA pinning as the immutable action reference, and environments provide reviewers, branch restrictions, and secret gating. [GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use), [GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

PR gates run in parallel:

1. Rust format/clippy/unit/integration/Wasm checks, dependency/license policy, and password KDF known-answer tests;
2. Login and Account format/lint/type/unit builds, locale completeness/pseudo-locale/RTL checks, SVG optimization/license checks, and bundle budgets;
3. OpenAPI lint, example validation, generated-client compile tests, OAuth discovery/JWKS contract tests, and an explicit contract-diff report;
4. clean D1 migrations plus invariant/concurrency tests;
5. Playwright desktop/mobile/WebKit/Chromium flows, virtual WebAuthn, embedded-browser fallback, dark/light/high-contrast/reduced-motion, axe/WCAG, and screenshot review;
6. packaged Wrangler dry runs and reproducible artifact/SBOM provenance.

Deployment order is expand schema -> Identity compatible with both UI versions -> Login -> Account BFF/assets -> synthetic smoke -> gradual promotion. Use separate staging/production environments and one shared production concurrency group across deploy and rollback. Cloudflare gradual deployments can expose version skew, so use version affinity/overrides and only canary code whose schema and wire contract tolerate both active versions. Tag telemetry with script version. Roll back Worker versions automatically on fast-burn or smoke failure; D1 changes use expand/contract and are not “rolled back” by deploying old code. [Cloudflare gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)

## Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| A passkey-only site | Excludes valid devices/user journeys and contradicts observed adoption friction; passkeys remain an encouraged phishing-resistant option, and an individual may choose one. |
| Put account pages back under Login | Mixes transient ceremony with durable administration and couples unrelated release/failure domains. |
| Make Account a second authority/database | Creates distributed transactions and conflicting ownership for contacts, credentials, sessions, and grants. |
| Broaden WebAuthn RP ID to `moesegfault.dev` | Removes subdomain isolation merely to avoid a redirect from Account. |
| Browser-only OAuth tokens in Account | Personal-data administration warrants a BFF; XSS would otherwise expose access/refresh tokens. |
| A single generic credential JSON table | Hides kind-specific invariants and makes every new factor a collection of nullable/special cases. |
| SMS as default 2FA | Number ownership is mutable and PSTN authentication is restricted; keep it optional for verification/recovery. |
| Runtime CDN import of `moesegfault-style` | Turns the design documentation host into an authentication availability dependency and permits visual drift. |
| Blindly apply RFC 9106's 64 MiB Argon2id profile in Workers | Two concurrent hashes plus Wasm/runtime state can exhaust the 128 MB isolate; measured algorithm agility is safer. |
| Dynamic client registration in phase one | Greatly enlarges redirect/consent/abuse control surface before there is a genuine ecosystem need. |

## Implementation slices and integration order

1. **Domain/schema:** normalize account/profile/contact/authenticator subtypes, factor-policy snapshots, avatar lifecycle, verification transactions, and outbox invariants.
2. **Password and registration:** password policy/KDF gate, password registration/login/recovery, optional passkey prompt, uniform failure semantics.
3. **Protocol:** complete discovery, code+PKCE, BFF/native client types, RFC 9068 access tokens, workload clients, revocation/introspection, pairwise claims and scopes.
4. **Presentation:** consume a pinned style-system build and reviewed SVGs; finish `zh-CN/en/ja`, theme, responsive/accessibility behavior, and external-browser fallback.
5. **Account target:** deliver profile/contact/avatar/security/session/grant UX, then insert the same-origin BFF and retire direct credentialed cross-origin Account calls.
6. **Operations:** Queue consumers, telemetry, SLO dashboards/burn alerts, synthetics/runbooks, CI gates, staged gradual deployment, and recovery drills.
7. **Future factors:** TOTP/hardware OTP only after recovery and step-up journeys pass usability and failure testing; publish capabilities only when endpoints work.

## Material risks and falsifiers

| Risk / assumption | Evidence that changes the decision or required response |
| --- | --- |
| Practical Argon2id fits Workers | Load tests showing memory termination, poor tail latency, or unacceptable CPU cost cause policy switch to WebCrypto PBKDF2 and rehash-on-login. |
| Account BFF cost is justified | If measured latency/operational burden exceeds benefit for non-sensitive pages, keep public profile reads static, but personal/security mutations remain behind BFF. |
| In-app handoff is understandable | Cross-platform task failure or abandonment requires tested platform-specific instructions/deep links; it does not justify embedded OAuth WebViews. |
| D1 meets correctness/latency needs | Repeated primary latency/SLO misses or inability to express atomic invariants triggers a storage ADR, not KV-based correctness shortcuts. |
| Playful central profile remains bounded | Product requests for feeds, moderation, badges, or relationship graphs trigger a separate community-profile service rather than more Identity JSON. |
| Passkey direct higher assurance is valid | Authenticator evidence or policy cannot establish required properties: lower the emitted `acr` and require another factor rather than overclaim assurance. |

## Consequences

Users get familiar password registration and login, optional passkeys, richer community-appropriate profiles, a real Account site, internationalized light/dark mobile UX, and standard federation into other services. The design adds an Account BFF and asynchronous notification/avatar operations, but eliminates the more damaging special cases: Login as an account portal, passkey-only recovery, browser-held OAuth tokens, and identity-by-email. The principal/credential/contact boundaries remain stable as authentication methods and downstream services grow.
