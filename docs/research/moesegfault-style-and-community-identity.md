# MoeSegfault visual system, community identity, and embedded-browser constraints

Research date: 2026-09-15

## Scope and evidence discipline

This note answers three concrete questions:

1. What does `kleedaisuki/moesegfault-style` actually define, including SVG assets and theme behavior?
2. What identity/profile patterns are evidenced by fandom-oriented communities rather than generic corporate social networks?
3. What constraints should a login/account experience assume on mobile and in embedded or in-app browsers?

Repository observations are pinned to `moesegfault-style` commit
[`1de514bfb53731fd4eda76ab10ab41aff41dc136`](https://github.com/kleedaisuki/moesegfault-style/tree/1de514bfb53731fd4eda76ab10ab41aff41dc136).
External examples are used as design evidence, not as proof that copying a field or flow will improve conversion.
Where this note moves from observation to a project recommendation, it says so explicitly.

## Executive synthesis

- **Observed:** MoeSegfault Style is already a coherent warm editorial system: cream/paper backgrounds, brown ink, coral/berry accents, gold sparkle, serif display headings, generous rounded surfaces, restrained motion, and light/dark/auto themes. Reimplementing it as an unrelated blue/purple SaaS login would be a design regression.
- **Observed:** the upstream icon inventory is deliberately tiny: the original 64x64 brand SVG and an extracted sparkle. It does **not** provide a general UI icon set. `BrandMark` renders a CSS-styled `K`, while `Icon(name="brand")` renders the actual SVG geometry. That distinction matters.
- **Recommended:** vendor or otherwise build-pin the exact style release and its two heritage SVGs for the login/account critical path. Do not depend at runtime on the floating `/latest/` alias. Extend the UI vocabulary with one consistent permissively licensed SVG set (Lucide is a reasonable candidate), while retaining the MoeSegfault brand and sparkle unchanged.
- **Observed:** AniList, pixiv, and AO3 treat community identity as more than legal/contact identity: avatar, banner, bio, highlight color, favourites, language choices, privacy controls, and pseudonyms all matter. At the same time, pixiv keeps account email private.
- **Recommended:** make onboarding richer but progressive: collect required account/authentication data first, then offer a skippable, playful profile card (avatar, display name/handle, accent, short bio), followed by optional private recovery contact. Do not require legal name, gender, full birthday, or phone merely to make the form appear “complete.”
- **Recommended:** keep stable account identity, private contact points, authenticators, public profile, and service-specific fandom data as separate data domains. A central account can be fun without becoming the database for every downstream service’s anime list.
- **Observed:** OAuth best current practice directs native apps to external user agents rather than developer-controlled WebViews. WebAuthn is HTTPS-only; cross-origin iframe access is disabled by default; and Android WebView passkey support requires a sufficiently recent host library plus explicit host-app integration. Therefore passkeys must be an enhancement, not the only path.
- **Recommended:** other services should redirect the top-level browsing context to `login.moesegfault.dev`; native apps should use a system authentication session/custom tab with Authorization Code + PKCE. In arbitrary in-app browsers, keep password/email login functional, avoid popup dependence, feature-detect passkeys, and provide a clear “Open in browser” escape hatch.

## 1. The actual MoeSegfault visual contract

### 1.1 Upstream intent and distribution

The upstream README describes the library as a “warm, editorial design system” shared by React, Astro, and plain web consumers. Its explicit principles are semantic design tokens, explicit CSS opt-in, thin framework wrappers, accessibility defaults, and exact-version pinning. It also warns that GitHub Pages is a CDN-like static origin, not a strong CDN with an SLA or ideal cache controls.

Evidence:

- [Upstream README at the inspected commit](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/README.md)
- [Package exports at the inspected commit](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/package.json)
- Exact static release entry: <https://style.moesegfault.dev/v0.1.2/css/all.css>
- Floating entry, unsuitable for a reproducible production build: <https://style.moesegfault.dev/latest/css/all.css>

The package is version `0.1.2`, GPL-3.0-or-later, ESM-only, and offers plain CSS as well as React 19+ and native Astro components. At the inspected commit, the README says npm publishing is not yet automated. This makes a blind `npm install @moesegfault/style` assumption unsafe until registry availability is verified.

**Project recommendation:** the authentication path should not acquire an avoidable runtime dependency on `style.moesegfault.dev`. Prefer one of:

1. vendoring the exact `v0.1.2` generated CSS and heritage SVGs with provenance/license notices; or
2. fetching an exact version/commit in the build with an integrity check and packaging it into the deployed asset bundle.

The exact CDN URL is acceptable for prototypes, but a login service should remain renderable if the documentation/static origin is unavailable.

### 1.2 Visual vocabulary

The following values are observations from the generated `v0.1.2` tokens, not newly chosen colors:

| Role | Light/default | Dark | Intended visual effect |
| --- | --- | --- | --- |
| Page | cream `#fff6ea` to `#fff1e2` | brown `#21130f` to `#19100e` | warm paper / dark cocoa |
| Surface | translucent `#fffbf4eb`, strong `#fffdf8` | `#2f1c17f0`, strong `#30201b` | editorial cards rather than cold dashboards |
| Text | brown `#4b2a1e`; heading ink `#26110b` | pale `#f6e7dc`; heading `#fff6ef` | low-chroma body, high-contrast headings |
| Accent | coral `#e66a3f`, strong `#bd4525` | coral `#f27a50`, strong `#ffb18c` | berry/coral interaction language |
| Ornament | gold `#ffb55e` | same | sparkle and warm highlight |
| Radius | 10 / 18 / 26 px, pill 999 px | same | soft, friendly card geometry |
| Body type | Atkinson Hyperlegible, Noto Sans SC, PingFang SC, Microsoft YaHei, system UI | same | readable Latin/CJK fallback chain |
| Display type | Georgia, Noto Serif SC, serif | same | editorial headings |
| Motion | 160 / 220 / 420 ms | same | restrained transitions |

Primary evidence:

- [DTCG token source](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/tokens/tokens.dtcg.json)
- [Generated token CSS](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/static-releases/v0.1.2/css/tokens.css)
- [Foundation CSS](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/src/styles/foundation.css)
- [Component CSS](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/src/styles/components.css)

The foundation supplies the warm radial-gradient page background, visible focus outline, selection colors, and responsive layout primitives. The components supply minimum 44px medium buttons, gradient primary buttons, paper surfaces, cards, badges, notices, and status dots. The login and account applications should consume these semantics instead of copying hex values into page-specific rules.

### 1.3 Theme and motion behavior

Theme is a three-state preference (`light`, `dark`, `auto`) expressed through `data-moe-theme` on the root. `auto` resolves through `prefers-color-scheme`; the package supplies a bootstrap-script generator that tolerates unavailable or invalid local storage. This is the upstream contract and should be shared by login and account, including the same storage key.

- [Theme helper implementation](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/src/theme.ts)
- [Generated light/dark token behavior](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/static-releases/v0.1.2/css/tokens.css)

Motion is one-shot and disabled/reduced under `prefers-reduced-motion`; focus inside an entering element cancels its animation so keyboard focus is not delayed or hidden. Glass is opaque-first progressive enhancement, does not animate blur, supports `prefers-reduced-transparency`, and has a forced-colors fallback.

- [Motion CSS](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/src/styles/motion.css)
- [Glass CSS](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/src/styles/glass.css)
- [Upstream visual-design rationale](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/docs/v0.1.2-design.md)

**Project recommendation:** an authentication form should use solid/strong surfaces by default. Local static glass on a decorative side panel is reasonable; a viewport-wide animated blur is contrary to the upstream system and is especially risky on low-end mobile WebViews.

## 2. SVG/icon inventory and extension strategy

### 2.1 Heritage assets actually available

| Asset/API | Actual content | Correct use | Important caveat |
| --- | --- | --- | --- |
| `brand.svg` | 64x64 coral gradient rounded square, cream `K` geometry, gold sparkle | favicon, product identity, account avatar placeholder, visible brand mark | Preserve geometry/colors; source license is GPL-3.0-or-later |
| `sparkle.svg` | extracted 13x13 sparkle path using `currentColor` | decoration, small status/accent ornament | Decorative by default; label only when it conveys meaning |
| React `Icon` | inline rendering for `brand` or `sparkle`, unique gradient IDs, accessible-title support | actual inline heritage SVG | Only two names exist |
| React `BrandMark` | CSS gradient glyph containing text `K`, plus visible label | wordmark-like component | It is **not** the actual brand SVG |

Evidence:

- [Brand SVG](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/src/icons/brand.svg)
- [Sparkle SVG](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/src/icons/sparkle.svg)
- [Asset provenance and accessibility notes](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/src/icons/README.md)
- [React `Icon` implementation](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/src/react/Icon.tsx)
- [React `BrandMark` implementation](https://github.com/kleedaisuki/moesegfault-style/blob/1de514bfb53731fd4eda76ab10ab41aff41dc136/packages/style/src/react/BrandMark.tsx)

### 2.2 Recommended UI icon policy

The upstream README explicitly says it does not mix in third-party glyphs. Login/account still need recognizable icons for email, phone, password visibility, passkey, authenticator, sessions, devices, consent, theme, language, camera/upload, recovery, warning, success, and navigation.

**Recommended split:**

- Heritage layer: copy/use upstream `brand.svg` and `sparkle.svg` unchanged.
- Functional layer: use a single stroke-based SVG vocabulary. [Lucide](https://github.com/lucide-icons/lucide) provides a large consistent SVG set and uses the [ISC license](https://github.com/lucide-icons/lucide/blob/main/LICENSE). Record the exact dependency version and license notice.
- Render functional icons inline with `currentColor` so semantic theme tokens control color. Do not encode whole SVGs as repeated data URLs in CSS.
- Keep icon-only buttons as native `<button>` elements with an accessible name; decorative icons should be removed from the accessibility tree. W3C guidance says decorative images use an empty alternative, while meaningful icon-only controls require an accessible name ([WAI decorative images](https://www.w3.org/WAI/tutorials/images/decorative/), [W3C Design System SVG icons](https://design-system.w3.org/styles/svg-icons.html)).
- Do not use emoji as the only functional icon. Emoji rendering varies by platform and its spoken label may not match the action. Emoji can remain part of friendly prose or decoration.

Suggested initial functional subset (names refer to Lucide concepts, not a required library API):

`mail`, `smartphone`, `lock-keyhole`, `key-round`, `fingerprint`, `shield-check`, `qr-code`, `monitor-smartphone`, `log-out`, `camera`, `upload`, `user-round`, `palette`, `languages`, `sun`, `moon`, `sparkles`, `circle-check`, `triangle-alert`, `chevron-left`, `chevron-right`, `external-link`, `copy`, `trash-2`.

## 3. What fandom communities teach about account identity

### 3.1 Strongest directly relevant observations

| Community/source | Observed profile/account affordance | Design implication | Evidence limit |
| --- | --- | --- | --- |
| AniList | `User` exposes a public name, Markdown bio, avatar, banner, favourites, statistics, and options. Options include preferred title/staff-name language, profile highlight color, notification behavior, and restricting messages to followed users. | Fandom identity is expressive and preference-rich. Avatar, color, display language, and interest signals are more native to this community than legal-name/company fields. | API shape shows the product model, not whether each field belongs in initial registration. |
| pixiv | Email is visible in the owner’s settings but not to third parties; profile images and cover/featured elements are edited separately; privacy affects owner-versus-visitor views. | Private contact and public persona should be separate. Provide “view as others” or very explicit visibility labels. | Help pages describe current behavior, not an ideal universal model. |
| AO3 | An account can have additional pseudonyms/pen names, allowing creators to retain identities used in different fandom contexts while gathering works under one account. | Stable account identity should not be identical to one immutable public display name. Consider future persona/pseud support without creating duplicate login identities. | AO3 pseuds remain linked to the account; they are not strong unlinkable anonymity. |

Primary references:

- [AniList `User` reference](https://docs.anilist.co/reference/object/user), also inspectable in the [official source at commit `03281c0`](https://github.com/AniList/docs/blob/03281c0a4bbf0c7f2097e0c935cddaed1096aa65/docs/reference/object/user.md)
- [AniList `UserOptions` reference](https://docs.anilist.co/reference/object/useroptions), also [official source at commit `03281c0`](https://github.com/AniList/docs/blob/03281c0a4bbf0c7f2097e0c935cddaed1096aa65/docs/reference/object/useroptions.md)
- [pixiv: email is not visible to other users](https://www.pixiv.help/hc/en-us/articles/235584328-Is-my-e-mail-address-visible-to-users-other-than-me)
- [pixiv: the owner view includes private items that visitors cannot see](https://www.pixiv.help/hc/en-us/articles/235583548-My-private-items-are-being-displayed)
- [pixiv profile-image constraints](https://www.pixiv.help/hc/en-us/articles/235644627-I-cannot-register-a-profile-picture-in-pixiv)
- [AO3 Pseuds FAQ](https://archive.transformativeworks.org/faq/pseuds?language_id=en)

### 3.2 Academic signal: pseudonymity is not merely missing “real identity”

Two peer-reviewed studies are useful guardrails:

- Donlan analyzed 600 fanfiction-author names and found frequent compounding, blending, and variant spelling; the paper interprets pseudonym creation as playful linguistic identity work, not merely concealment. [Internet Pragmatics, DOI 10.1075/ip.00040.don](https://doi.org/10.1075/ip.00040.don).
- Gerrard’s qualitative study of teen-drama fandom (22 participants, with detailed analysis of a smaller subset) describes fans separating fandom identity from real-name platform identity to avoid stigma or harassment. [First Monday, DOI 10.5210/fm.v22i8.7877](https://doi.org/10.5210/fm.v22i8.7877).

These studies support allowing memorable pseudonymous handles and keeping legal/contact identity private. They do **not** quantify the conversion impact of a particular registration UI, and Gerrard’s small, context-specific qualitative sample should not be generalized to all anime fans.

### 3.3 Recommended account/profile boundary

The central identity service should use separate structures rather than one ever-growing `users` row:

| Domain | Suggested contents | Default exposure |
| --- | --- | --- |
| Account core | opaque immutable subject ID, state, creation/update timestamps | internal; pairwise or scoped subject to relying parties where appropriate |
| Login identifiers | email(s), phone(s), normalized value, verification/status, primary flag | private; released only under an explicit scope/consent policy |
| Authenticators | password credential metadata, passkeys, TOTP/recovery methods, security keys | account owner/security UI only |
| Public persona | unique handle, changeable display name, avatar, short bio, optional pronouns, profile accent | explicitly previewed and user-controlled |
| Preferences | locale, light/dark/auto, time zone, communication preferences | private by default; only share when a service needs them |
| Service-specific fandom data | anime/manga lists, favourites, character/staff collections, community badges | downstream service, not central login/account by default |
| Future personas | additional pseud/alias with its own display name/avatar/bio and disclosure rules | opt-in; avoid promising unlinkability unless technically provided |

This structure follows a production identity principle also visible in NIST’s subscriber-account model: assign a unique opaque account identifier and bind authenticators/attributes to it rather than treating email as identity. See [NIST SP 800-63A-4 Subscriber Accounts](https://pages.nist.gov/800-63-4/sp800-63a/accounts/).

NIST federation guidance also recommends releasing only the attributes a relying party needs and, where feasible, releasing derived attributes (for example, an age threshold) rather than the full underlying value. See [NIST SP 800-63C-4 Data Minimization](https://pages.nist.gov/800-63-4/sp800-63c.html#data-minimization).

**Blind spot to avoid:** “richer registration” can easily become needless personal-data collection. A fandom-oriented service has little justification for requiring legal name, binary gender, exact birthday, address, school, or employer. If age eligibility is later required, prefer storing/releasing an appropriate verified threshold claim where feasible rather than exposing full birth date to every service.

### 3.4 Recommended progressive onboarding

The user explicitly requested email, optional mobile with country code, and optional avatar. A richer experience need not be a single intimidating form.

| Stage | Required | Optional and skippable | Tone/interaction |
| --- | --- | --- | --- |
| 1. Create the account | email; password or another non-passkey primary route; terms/age attestation if actually required | passkey enrollment can be offered after account proof | concise, reliable, password-manager/autofill friendly |
| 2. Make it yours | unique handle and display name (one may initially derive from the other) | avatar upload, generated MoeSegfault avatar, coral/berry accent, short bio | live “profile card” preview with sparkle, not a corporate questionnaire |
| 3. Recovery/contact | none beyond the verified primary email unless policy requires it | phone with searchable country calling code and verification; additional email later | explicitly label phone as private, optional, and explain its purpose |
| 4. Welcome | completion | a few interest tags, favourite character/work, or intro prompt should be a downstream/profile enrichment activity | skippable “decorate later” path to avoid blocking sign-in |

Field-level guidance:

- **Email:** private, normalized conservatively, verified, never used as public handle. Use `type="email"` and `autocomplete="email"`.
- **Mobile:** optional; searchable country/region calling-code selector plus a national-number field; normalize to E.164 after parsing and retain enough metadata for local display. E.164 is the international numbering plan ([ITU-T E.164](https://www.itu.int/rec/T-REC-E.164)). Do not default `+86` merely because the interface language is Chinese; locale, residence, and phone numbering country are different facts.
- **Handle:** pseudonymous and fun, backed by a separate immutable subject ID. Show availability and the resulting profile URL. Do not reveal whether an email/phone already exists through this availability UI.
- **Display name:** Unicode-friendly and changeable; do not conflate it with the globally unique handle.
- **Avatar:** optional with a generated/local default. Avoid email-derived public avatar URLs (for example, hash-based third-party avatar lookup), which couple a private identifier to a public resource. Crop client-side for preview, but validate/decode/re-encode server-side in the eventual media service.
- **Bio/pronouns/accent:** optional. These create personality at low privacy cost when users control visibility. Do not force a fixed gender taxonomy.
- **Theme/locale:** apply immediately and persist as account preference after authentication; before authentication, retain device-local preference. Login and account should use the same keys/semantics.

W3C WCAG guidance supports programmatically identifying common input purposes so browsers and assistive technology can autofill and explain them. Use correct visible labels plus `autocomplete` values such as `username`, `new-password`, `email`, `tel-country-code`, and `tel-national` where the form structure matches them. See [WCAG 2.2 Understanding 1.3.5](https://www.w3.org/WAI/WCAG22/Understanding/identify-input-purpose.html) and [Technique H98](https://www.w3.org/WAI/WCAG22/Techniques/html/H98.html).

## 4. Mobile and in-app browser constraints

### 4.1 Authentication-context matrix

| Context | What standards/platform evidence says | Recommended behavior |
| --- | --- | --- |
| Ordinary top-level HTTPS browser | WebAuthn is available only in a secure context and may vary by browser/platform. | Offer passkey when capability checks succeed, but retain email/password and recovery routes. |
| Login embedded as a cross-origin iframe | WebAuthn Level 3 disables `create()` and `get()` in cross-origin iframes by default unless delegated through Permissions Policy. Embedded use also has visibility/UI-redressing considerations. | Do not make iframe embedding the primary integration. Redirect the top-level browser to the login origin. |
| Arbitrary third-party in-app browser | The host controls the embedded user agent; passkey/platform behavior cannot be assumed. UA strings are not a reliable capability oracle. | Feature-detect, handle WebAuthn exceptions, keep ordinary form login functional, and expose “Open in browser.” Do not hide fallback merely because an in-app-browser UA substring matched. |
| Native app OAuth/OIDC | RFC 8252 says authorization requests from native apps should use external user agents, primarily the browser; embedded user agents let the host app inspect or modify the flow. | Use Authorization Code + PKCE in the system authentication session/custom tab, then return via a claimed HTTPS/app link or another registered native redirect. |
| iOS first-party app | Apple provides `ASWebAuthenticationSession` for web-service authentication and callback delivery. | Use `ASWebAuthenticationSession`, not a generic `WKWebView`, for authorization. |
| Android first-party WebView that must support passkeys | Android documents native Credential Manager support in `android.webkit.WebView` through AndroidX WebKit 1.12.0+; the app must check/enable WebAuthentication and associate app/site through Digital Asset Links. | Treat this as explicit native integration work. A web page cannot make an arbitrary host WebView meet these prerequisites. |

Primary sources:

- [RFC 8252: OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252)
- [RFC 9700: OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700), including exact redirect matching and PKCE guidance
- [Web Authentication Level 3, Permissions Policy and iframe use](https://www.w3.org/TR/webauthn-3/#sctn-permissions-policy)
- [MDN Web Authentication API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API)
- [Android: Authenticate users with WebView](https://developer.android.com/identity/sign-in/credential-manager-webview)
- [Apple `ASWebAuthenticationSession`](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)
- [Google OAuth policy prohibiting developer-controlled embedded user agents](https://developers.google.com/identity/protocols/oauth2/policies#secure-browsers) as production corroboration of the RFC model
- [MDN: why feature detection is preferable to UA sniffing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Browser_detection_using_the_user_agent)

### 4.2 Concrete flow rules

1. Use top-level same-tab redirects for authorization. Popup-only authorization is fragile in embedded browsers and unnecessary for a dedicated login service.
2. Maintain the authorization transaction server-side or in an integrity-protected transaction handle so leaving the in-app browser and opening the system browser does not silently discard the relying-party request.
3. For native public clients, require Authorization Code + PKCE (`S256`). RFC 9700 requires PKCE for public clients and recommends it more broadly.
4. Match registered redirect URIs exactly, apart from the narrowly specified loopback-port exception. Do not implement a generic `return_to` open redirect.
5. Never put access tokens in front-channel URLs. Complete the code exchange at the appropriate client/backend boundary.
6. When passkey capability is absent or a ceremony fails due to the environment, return to the method chooser with a specific, recoverable message; do not strand the authorization transaction.
7. Do not represent a detected WebAuthn API as proof that a usable credential/provider exists. Detection controls whether to offer/attempt; the ceremony outcome remains authoritative.
8. If a downstream service tries to place login in an iframe, provide a deliberate top-level “Continue to MoeSegfault Login” link rather than attempting to make every embedded edge case normal.

### 4.3 Mobile layout contract

- Use one-column form flow at narrow widths; optional decoration may collapse below or disappear without removing information.
- Keep primary action and method-switch controls at least 44 CSS px high. MoeSegfault Style’s medium button is already 2.75rem (44px). WCAG 2.2 AA requires at least 24x24 CSS px or sufficient spacing; 44x44 is the enhanced target and a sensible authentication default ([W3C target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum), [enhanced 44px target](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced)).
- Pad full-bleed shells and bottom actions with `env(safe-area-inset-*)` fallbacks so notches, rounded corners, and browser chrome do not cover controls ([MDN `env()` and safe-area insets](https://developer.mozilla.org/en-US/docs/Web/CSS/env)).
- Avoid a fixed `100vh` centered card as the only layout. Dynamic mobile chrome and the virtual keyboard can reduce the visible viewport; content must remain scrollable, and focused fields/actions must not be trapped below the keyboard.
- Use semantic form controls and the correct input modes/types. Do not replace the country selector or password field with inaccessible custom `div` widgets.
- Errors should be adjacent to their fields and summarized at form level after submit; focus should move predictably, not to a transient toast.
- Login/account navigation, theme, and language controls must remain usable without hover. Upstream hover-lift is already guarded by `@media (hover: hover)`.

## 5. Suggested visual composition

This is a design recommendation synthesized from the upstream system rather than an existing upstream page:

```text
desktop/tablet
┌────────────────────────────────────────────────────────────┐
│ [brand SVG] MoeSegfault       Language   Theme              │
│                                                            │
│ ┌─ warm illustration / copy ─┐  ┌─ strong paper card ────┐ │
│ │ sparkle, short community   │  │ Sign in / Create       │ │
│ │ promise, privacy cue       │  │ native fields          │ │
│ │ optional; no fake metrics  │  │ passkey as an option   │ │
│ └────────────────────────────┘  │ help + method chooser   │ │
│                                 └──────────────────────────┘ │
└────────────────────────────────────────────────────────────┘

mobile / in-app browser
┌──────────────────────────────┐
│ [brand SVG]   Lang   Theme   │
│ Welcome back / Join atelier  │
│ ┌─ strong paper card ──────┐ │
│ │ fields, errors, actions  │ │
│ │ all methods remain here  │ │
│ └──────────────────────────┘ │
│ Open in browser (when useful)│
└──────────────────────────────┘
```

Copy can be playful without obscuring contracts:

- “Create your atelier card” for optional profile decoration.
- “Pick a handle your fandom friends will recognize” for the public pseudonymous handle.
- “Phone number — optional, private, used only for recovery/security” for mobile contact.
- “Add a passkey” rather than “Passkey required.”
- “Skip and decorate later” for nonessential profile enrichment.

Avoid invented claims such as “military-grade,” “zero risk,” or an uptime percentage in UI decoration. Warmth should come from art direction and clear language, not unsupported trust theater.

## 6. Acceptance checklist for implementers

### Style and icons

- [ ] CSS/assets come from exact version `0.1.2` or pinned commit `1de514b...`, not `/latest`.
- [ ] Brand and sparkle match the upstream SVG path geometry.
- [ ] Heritage assets retain provenance/license documentation.
- [ ] A single functional SVG set is used; icons inherit `currentColor`.
- [ ] Icon-only controls have accessible names; decorative icons are hidden from assistive technology.
- [ ] Light, dark, and auto share the upstream `data-moe-theme` contract and do not flash the wrong theme on initial render.
- [ ] Reduced motion, reduced transparency, forced colors, keyboard focus, and solid glass fallback remain functional.

### Community account experience

- [ ] Email is private and cannot accidentally appear in public profile/API responses.
- [ ] Optional phone uses a country-calling-code selector and E.164 normalization, with clear purpose text.
- [ ] Immutable subject ID is separate from email, phone, handle, and display name.
- [ ] Avatar is optional and has a first-party default; public profile preview is available.
- [ ] Legal name, exact birthday, and gender are not collected without a concrete requirement.
- [ ] Optional profile fields do not block account creation and can be managed later at `account.moesegfault.dev`.
- [ ] Downstream-service interests remain namespaced/service-owned unless a cross-service use case and consent model are explicitly designed.

### Mobile / embedded browser

- [ ] Authorization uses top-level redirects; login is not designed as a cross-origin iframe widget.
- [ ] Password/email login remains available when passkey APIs/providers fail.
- [ ] Passkey availability is feature-detected; UA sniffing does not choose the only auth path.
- [ ] Native-app integrations use system authentication sessions/custom tabs with Authorization Code + PKCE.
- [ ] The flow survives opening externally without losing the authorization transaction.
- [ ] Controls are touch-sized, safe-area padded, scrollable with the keyboard open, and do not require hover.
- [ ] “Open in browser” is offered when the embedded environment cannot complete the chosen method.

## 7. Remaining uncertainties and valuable follow-up tests

1. The account/login implementation should be tested on real WeChat, QQ, Telegram, Discord, and common OEM in-app browsers; standards cannot predict each host app’s cookie, download, deep-link, or WebAuthn behavior. Do not encode unverified host-specific assumptions into the core flow.
2. Test at least Safari/iOS, Chrome/Android, Android WebView both below and above the documented Credential Manager integration threshold, and a desktop browser with no platform passkey provider.
3. The upstream style package is at `0.x` and does not yet promise a stable npm release. Decide whether this repository vendors release artifacts or establishes a pinned source dependency; document the update procedure.
4. If the project introduces persona/pseud support, specify whether personas are visibly linked. AO3-style pseuds are linked aliases; “unlinkable identities” is a materially different privacy product and should not be implied by UI copy.
5. Profile avatar moderation, content rating, and media processing need their own product policy and service boundary. pixiv demonstrates that community avatars can require sensitive-content behavior, but its exact policy should not simply be copied.

