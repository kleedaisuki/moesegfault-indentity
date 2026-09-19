# Registration email verification and browser avatar processing

**Research date:** 2026-09-19  
**Scope:** implementation guidance for making email verification part of registration and for
adding a faithful avatar preview plus bounded browser-side image normalization. This supplements
[`email-verification-cloudflare.md`](./email-verification-cloudflare.md); it does not repeat that
note's D1/outbox/token analysis.

Labels used below are **Observed** (directly documented or present in this repository),
**Inferred** (a conclusion from those observations), and **Recommended** (a design choice that
still needs project validation).

## Executive judgment

1. Treat the requested registration behavior as a **blocking verification loop**, not merely an
   automatically sent email. After credential creation, keep the principal in a pending
   enrollment state and limit that session to entering a code, resending, correcting the email,
   viewing required recovery material, and signing out. Activate normal account use in the same
   authoritative transition that verifies the email.
2. Reuse the existing eight-digit, ten-minute, single-use verification transaction and durable
   outbox. Registration should commit its local state before requesting delivery; provider delay
   must become a visible "sent/pending/retry" state rather than a rolled-back or half-created
   credential.
3. Render a dedicated code page immediately after registration and whenever a pending principal
   returns. Show the destination, validity period, delivery status, resend cooldown, and a way to
   correct the email. Use one ordinary text input with `autocomplete="one-time-code"` and
   `inputmode="numeric"`; do not split eight digits into eight focus-managed controls.
4. For avatars, preview the *normalized upload artifact*, not merely the original local file.
   Decode with EXIF orientation applied, center-crop to the square contract, downscale once to at
   most 1024 x 1024 without upscaling, and encode WebP at an initial quality of about `0.88`.
   This number is a starting policy, not a universal quality fact; validate it on an anime/pixel-
   art/photo corpus and adjust from evidence.
5. Use `URL.createObjectURL()` for the preview and revoke the previous URL on replacement and
   teardown. Close each `ImageBitmap`. Keep backend signature/dimension/size validation: browser
   processing improves bandwidth and UX but is not an authoritative media boundary.

## 1. Cloudflare Email Service: current production facts

| Claim | Evidence label | Implementation consequence |
| --- | --- | --- |
| Email Sending remains **Beta**. The structured Workers API is `env.EMAIL.send({...})`, returns `{messageId}`, and throws errors with stable codes such as `E_RECIPIENT_SUPPRESSED`, `E_RATE_LIMIT_EXCEEDED`, and `E_DAILY_LIMIT_EXCEEDED`. | **Observed** — [Cloudflare Workers Email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) (updated 2026-09-16). | Keep the existing narrow mail adapter/outbox. Persist bounded provider outcome classes and the message ID; never make UI wording depend on provider error strings. |
| A sending domain must be onboarded before arbitrary-recipient mail. Before onboarding, mail is restricted to account-verified destinations; after onboarding Cloudflare documents that any recipient is allowed. | **Observed** — [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/). | Staging must prove delivery to an address outside the Cloudflare account before release. Local Wrangler simulation is not that proof. |
| `send_email` bindings can restrict senders with `allowed_sender_addresses`. | **Observed** — [Configure send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/). | The repository's existing `allowed_sender_addresses: ["identity@moesegfault.dev"]` is the correct shape. Do not add a destination allow-list to the production registration mailer. |
| Cloudflare's own signup example creates an unverified user, gives the token a TTL, sends verification during signup, and activates only after verification. | **Observed** — [Cloudflare user signup flow](https://developers.cloudflare.com/email-service/examples/email-sending/signup-flow/). | This supports the product flow, not the example's storage architecture. **Do not copy** its KV read/modify/write sequence, synchronous pair of sends, or HTML interpolation; this repository's transactional D1 state and escaped bilingual templates are stronger boundaries. |
| Cloudflare retries SMTP soft bounces and records outbound delivery in Email Service metrics/logs. Provider acceptance is not inbox placement. | **Observed** — [Email lifecycle](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/). | UI copy should say the message was queued/sent to the provider, not promise inbox delivery. Preserve resend and email-correction recovery paths. |

**Observed repository fit.** `wrangler.identity.jsonc` already defines an `EMAIL` binding restricted
to `identity@moesegfault.dev`; ADR-0004 already provides the durable encrypted outbox, resend
limits, eight-digit code, ten-minute TTL, and atomic completion flow. The missing product behavior
is chiefly registration orchestration and activation state, not another mail subsystem.

## 2. What "verify during registration" should mean

### 2.1 Product state, not just an email side effect

**Observed.** OWASP says email ownership should be verified before enabling account use, and the
verification material should be random, single-use, and time-limited. GOV.UK distinguishes a
blocking loop (no service use before confirmation) from a non-blocking loop (use continues with
reminders); it says the blocking flow's activation page should be the only page shown before
activation. See the [OWASP Email Validation and Verification Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html)
and [GOV.UK Confirm an email address](https://design-system.service.gov.uk/patterns/confirm-an-email-address/).

**Inferred.** Automatically starting the existing contact-verification transaction while leaving
the principal fully active would be a non-blocking reminder flow. That does not satisfy the plain
product meaning of "email verification is required at registration."

**Recommended state model:**

```text
registration submitted
        |
        | commit credential + pending principal + unverified email
        | commit verification transaction + outbox
        v
pending_email_verification
   |        |          |
   |        |          +-- correct address -> cancel old tx, issue/send new tx
   |        +------------- resend -> supersede old tx, cooldown applies
   +---------------------- correct code -> verify email + activate principal atomically
                                      |
                                      v
                                    active
```

The pending session is useful for continuity but is not an ordinary active-account session. Its
route allow-list should include code completion, resend, email correction, recovery-code display
when the chosen authenticator creates recovery material, and logout. A stale browser refresh or a
later login must reconstruct the same pending screen from server state.

### 2.2 Strongest alternative and why it is not preferred

| Model | Benefit | Cost / failure mode | Judgment |
| --- | --- | --- | --- |
| Verify email before creating any principal | No abandoned principal rows | Requires a separate durable signup transaction capable of carrying profile, username reservation, password-verifier/passkey ceremony state, and recovery-material sequencing. It creates a second account-creation model. | Not preferred for this codebase. |
| Create active account, auto-send, show a dismissible reminder | Lowest implementation cost; mail outage never blocks use | Email is not actually required during registration; username login can bypass it. | Does not meet the request. |
| Create pending principal with constrained enrollment session | Reuses existing registration and verification state; delivery can retry; refresh/re-entry is deterministic | Needs an explicit activation guard on login/OAuth/account routes and cleanup policy for abandoned pending principals. | **Recommended.** One state machine, no special client-only flag. |

### 2.3 Verification screen requirements

**Observed.** GOV.UK recommends showing where the message was sent, allowing resend and correction
of an incorrectly entered address, explaining expired/used/superseded states, and showing the
activation page immediately after address entry and again if the user returns before activation.
NIST's customer-experience guidance says to tell users in advance how the code arrives, when to
expect it, and how long it remains valid. See [GOV.UK's email pattern](https://design-system.service.gov.uk/patterns/confirm-an-email-address/)
and [NIST SP 800-63A-4 customer experience](https://pages.nist.gov/800-63-4/sp800-63a/customer/).

**Observed.** The HTML Standard defines `autocomplete="one-time-code"`. Apple documents that the
same value enables verification-code AutoFill on its platforms. GOV.UK's mature code-entry pattern
uses a single `type="text"` input with `autocomplete="one-time-code"` and
`inputmode="numeric"`. See the [HTML autofill field standard](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill-field),
[Apple AutoFill guidance](https://developer.apple.com/documentation/security/enabling-password-autofill-on-an-html-input-element),
and [GOV.UK Confirm a phone number](https://design-system.service.gov.uk/patterns/confirm-a-phone-number/).

**Recommended UI contract:**

- Heading: "Verify your email"; state the exact (or deliberately masked) destination and ten-minute
  expiry. At initial signup, showing the entered address is appropriate because the user just
  supplied it; use masking on unrelated unauthenticated recovery pages.
- One text control: `type="text"`, `inputmode="numeric"`,
  `autocomplete="one-time-code"`, `maxlength="8"`, and a visible label. Normalize pasted spaces
  and ASCII hyphens before validation; do not use `type="number"` (codes are strings and leading
  zero is meaningful).
- Primary action verifies. Secondary actions are "Resend code" (with an actual cooldown state) and
  "Change email". Resend must not clear user-entered digits until a new transaction is accepted.
- Distinguish actionable states in plain language: delivery pending/retrying, wrong format, wrong
  code, expired/superseded code, resend cooldown, and verified. Do not turn every provider delay
  into "registration failed."
- Use an existing `role="status"`/polite live region for delivery and cooldown updates; associate
  input errors with the field. WCAG requires text identification of input errors and
  programmatically determinable status messages: [WCAG 2.2 error identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification)
  and [status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages).
- If passkey registration returns one-time recovery codes, preserve the repository invariant that
  the user sees/saves them before any navigation to email verification. The next explicit step can
  then enter the same pending-email screen.

**Observed.** NIST SP 800-63A-4 requires confirmation codes used to validate an address to have at
least six decimal digits (or equivalent), use an approved random source, expire within at most 24
hours for email, and be invalidated on use. Its usability section stresses legible, non-confusable
code typography. See [confirmation-code requirements](https://pages.nist.gov/800-63-4/sp800-63a/ial-general/).
The repository's eight digits and ten-minute expiry are stricter project policy, not values
mandated by NIST.

## 3. Avatar preview and reasonable compression

### 3.1 Current contract and mismatch

**Observed repository state.** The API accepts AVIF, JPEG, PNG, or WebP up to 10 MiB, but the
Worker also requires a square image from 1 to 8192 pixels per side. Both Login and Account upload
the original `File`; Account has no pre-upload preview, while Login shows only the filename.
The Worker validates signatures and dimensions and stores the submitted bytes unchanged in R2.

**Inferred.** A preview that uses only the original file can disagree with the upload artifact
after crop/compression, and accepting non-square selection only to reject it after registration is
avoidable friction. The square crop, final encoding, and preview should therefore be one normal
client pipeline.

### 3.2 Platform facts

| Platform behavior | Evidence label | Consequence |
| --- | --- | --- |
| `createImageBitmap(file)` is broadly available; its default `imageOrientation: "from-image"` applies EXIF orientation. It supports optional resize dimensions and a `resizeQuality` hint. | **Observed** — [MDN `createImageBitmap`](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap). | Explicitly request `imageOrientation: "from-image"`; calculate the crop from the oriented bitmap's width/height. Do not separately rotate again. |
| Canvas `drawImage()` supports source rectangles, so a centered square crop and a single scale can be one draw. | **Observed** — [MDN `drawImage`](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage). | Use `side = min(width,height)` and centered `(sx,sy,side,side)`; draw directly to the final square canvas. |
| `toBlob(type, quality)` supports a `0..1` lossy-quality hint. PNG is the mandatory fallback when the requested encoder is unsupported; WebP/JPEG are commonly available. | **Observed** — [MDN `HTMLCanvasElement.toBlob`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob). | Request WebP, then verify `blob.type === "image/webp"`; do not label fallback PNG bytes as WebP. Treat `0.88` as an encoder hint, not a cross-browser visual metric. |
| WebP supports lossy/lossless content and transparency and generally compresses better than JPEG/PNG; AVIF can compress better but has shallower support. | **Observed** — [MDN image format guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types). | WebP is the pragmatic normalized upload format. Do not require client AVIF encoding: Canvas does not guarantee it. |
| Object URLs retain a reference until released; `ImageBitmap.close()` disposes graphical resources. | **Observed** — [MDN `createObjectURL`](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static), [`revokeObjectURL`](https://developer.mozilla.org/en-US/docs/Web/API/URL/revokeObjectURL_static), and [`ImageBitmap.close`](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap/close). | Revoke the previous preview URL when replaced and on component teardown; close the bitmap in `finally`. |
| `OffscreenCanvas.convertToBlob()` is available in workers and broadly available since 2023, but `imageSmoothingQuality` remains non-Baseline. | **Observed** — [MDN `OffscreenCanvas.convertToBlob`](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/convertToBlob) and [`imageSmoothingQuality`](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingQuality). | Set smoothing quality as a best-effort hint, but correctness cannot depend on it. A worker is an optional measured optimization, not a requirement for a once-per-profile action. |

### 3.3 Recommended single pipeline

```text
File selected
  -> reject empty / >10 MiB before decode
  -> createImageBitmap(file, { imageOrientation: "from-image" })
  -> validate decoded dimensions
  -> center-crop the oriented bitmap to a square
  -> draw once to min(squareSide, 1024) x min(squareSide, 1024)
  -> encode WebP quality 0.88
  -> verify output MIME and <=10 MiB
  -> wrap Blob as a File with a .webp name
  -> preview exactly that File via object URL
  -> submit exactly that File
```

**Recommended parameters (provisional):**

| Parameter | Initial value | Rationale and revision trigger |
| --- | --- | --- |
| Geometry | center crop, square | Matches the current server invariant and all current `object-fit: cover` displays. Add an interactive crop only if real feedback shows subject truncation; it is not needed to deliver a correct preview. |
| Maximum side | 1024 px, never upscale | Far above today's 96 px Account rendering (including high-density screens), leaves room for future profile use, yet sharply bounds decode output and upload bytes. Reduce to 512 only after viewing the real avatar corpus; increase only for a concrete larger display. |
| Format | WebP | Good browser decoding/encoding and alpha support; accepted by the current API. Verify the actual returned MIME because unsupported encoders fall back to PNG. |
| Quality | 0.88 | Conservative starting point for faces, anime art, and gradients. Browser encoder quality is not standardized as a perceptual target. Compare thumbnails and bytes before changing it. |
| Metadata / orientation | apply EXIF orientation while decoding; Canvas output carries the rendered pixels rather than the original EXIF orientation | Prevents sideways previews and makes preview bytes agree with uploaded bytes. Server-side normalization remains the long-term authoritative place for deterministic metadata/color policy. |
| Failure fallback | keep the selected file and show a localized, actionable processing error; do not silently upload a differently cropped original | A silent fallback recreates the preview/upload mismatch and, for non-square files, merely defers failure to the Worker. |

**Recommended quality validation.** Build a small checked-in test corpus or reproducible fixtures
covering a camera JPEG with EXIF rotations 1/3/6/8, transparent PNG, anime illustration with thin
lines, pixel art, dark gradient, and AVIF/WebP inputs. For each, assert output MIME, square
dimensions, no upscaling, size bound, and crop geometry. Review the 96 px and 192 px rendered
previews side-by-side on light/dark backgrounds. Track median and p95 output bytes. There is no
credible universal quality-slider value; human thumbnail review plus byte distributions is more
decision-relevant than optimizing a full-resolution metric alone.

### 3.4 Production boundary

**Observed.** Canvas re-encoding normalizes what a cooperating browser sends, but clients can call
the API directly. The existing Worker correctly re-checks byte size, signature, MIME agreement,
and square dimensions.

**Recommended.** Keep those checks unchanged. The browser pipeline is a latency/bandwidth and
preview-consistency feature, not a replacement for server validation. ADR-0003's longer-term
server decode/re-encode/metadata-strip/variant pipeline remains the correct production endpoint if
multiple clients or deterministic output become important. Do not add heavyweight client codecs
until native WebP output is shown to fail the supported-browser matrix.

## 4. Focused acceptance checks

### Registration

- A successful password registration and a successful passkey registration both create/start
  exactly one current email-verification transaction and land on the verification experience.
- Recovery codes, when produced, remain visible before advancing to verification.
- Refresh and later sign-in reconstruct pending verification from server state; normal Account and
  OAuth use remains unavailable until activation.
- Correct code atomically makes the email verified and principal active; replay is harmless.
- Resend respects cooldown, supersedes the old code, and leaves one valid transaction.
- Email correction invalidates the old destination/code and issues to the new destination.
- Provider delay/backlog is presented as pending/retrying, not as loss of the created credential.
- The code input supports paste and AutoFill, preserves leading zeroes, and reports format/server
  errors accessibly.

### Avatar

- Selecting a rotated camera JPEG produces an upright square preview and uploads the same pixels.
- Portrait and landscape images use the documented centered crop; small squares are not upscaled.
- Transparent PNG remains visually correct after WebP encoding.
- The resulting file is WebP, square, at most 1024 px per side, and below the API's 10 MiB limit.
- Selecting a second file revokes the first preview URL; teardown revokes the last URL and decoded
  `ImageBitmap` resources are closed.
- Decode/encode failure retains the prior valid selection/preview and produces localized status
  text; it does not submit a mismatched raw file silently.

## 5. Uncertainties that should remain visible

- Cloudflare Email Sending is still Beta; staging delivery across Gmail, Outlook, QQ Mail, and 163
  Mail remains a rollout observation rather than a conclusion from documentation.
- The recommended blocking lifecycle is a product interpretation of the explicit request. If the
  owner actually wants a non-blocking reminder, that is a different acceptance criterion and must
  be named as such.
- Center crop is the smallest coherent implementation, but user-positioned cropping may be worth
  adding after usability evidence. Starting with a crop editor before observing truncation would
  add state and accessibility work without evidence.
- WebP quality `0.88` and 1024 px are tunable policy values. Real corpus measurements should revise
  them; they are not standards requirements.
