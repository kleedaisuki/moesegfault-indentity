# Device-code login from a CLI or remote service

Use this flow for a person signing into a CLI, headless installation, or remote
moeSegFault service that cannot receive a browser callback. The person approves in
an ordinary browser on another device. A web BFF or native app with a practical
callback should keep Authorization Code + S256 PKCE instead.

This is delegated **human** login, not workload identity, `client_credentials`,
SSH authentication, or permission to call every moeSegFault API. Identity does not
issue independently addressed resource audiences: access-token `aud` remains the
registered `client_id`. A service owns its local account/session and business roles. Human-approved
`offline_access` can support background work in that user's context; it does not
turn their refresh token into independent workload identity.

## Registration and deployment

Use an environment-specific fixed issuer:

- Production: `https://identity.moesegfault.dev`
- Staging: `https://identity-staging.moesegfault.dev`

Discover `ISSUER/.well-known/openid-configuration`; require the returned `issuer`
to exactly match configuration, the device grant in `grant_types_supported`, and
`device_authorization_endpoint`. Checked-in code is not proof that an environment
has deployed it. A missing endpoint means this flow is unavailable there.

Ask the Identity operator to provision the following non-secret native-client
manifest through the reviewed environment migration stream:

```json
{
  "client_id": "remote-console-staging",
  "display_name": "Remote Console (staging)",
  "client_type": "native",
  "token_endpoint_auth_method": "none",
  "sector_identifier": "console-staging.example.com",
  "subject_salt_revision": 1,
  "device_authorization_enabled": true,
  "redirect_uris": [],
  "scopes": ["openid", "profile", "offline_access"]
}
```

Device authorization is explicitly opt-in; existing clients default to disabled.
A device-enabled client may omit redirects by passing `redirect_uris: []`. An app
also using browser callbacks must still register each exact redirect URI. Native
clients have no secret. A confidential remote backend may instead register
`private_key_jwt` and its public JWK; its private key stays in its own secret store.
Do not add the remote service to Identity's first-party browser CORS allowlist.

The operator runs `node scripts/generate-oauth-client-migration.mjs MANIFEST.json`
in the Identity repository, reviews the create-only SQL, then applies it in the
matching environment overlay. The skill itself does not provision runtime access.

## Start, display, and poll

All device and token requests use HTTPS form POSTs to discovered endpoints. The
following requests describe wire data, not a shell command that writes codes into
shell history or diagnostic logs:

```http
POST {device_authorization_endpoint}
Content-Type: application/x-www-form-urlencoded

client_id=remote-console-staging&scope=openid%20profile%20offline_access
```

The JSON response has `device_code`, `user_code`, `verification_uri`,
`verification_uri_complete`, `expires_in`, and `interval`. Current defaults are
600 seconds and a five-second initial polling interval; use the actual response
rather than assuming those values.

1. Retain `device_code` only in the initiating process's private login state.
   Display `user_code` and `verification_uri` to the person. An optional link or QR
   code may use `verification_uri_complete`; always display the human code too.
2. Explain that the person must compare the browser's code and application name
   with this exact login attempt. Never ask them to approve a code received from
   chat, email, or someone else's terminal. Opening the link does not approve it.
3. Wait at least `interval` seconds before the first poll, then POST:

```http
POST {token_endpoint}
Content-Type: application/x-www-form-urlencoded

client_id=remote-console-staging&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code={FORM_ENCODED_DEVICE_CODE}
```

There is no `redirect_uri`, PKCE verifier, or OIDC nonce in this grant. Keep each
pending login bound to the initiating local user/session. A remote multi-user
service must not attach an unclaimed token response to whichever user next polls
its own UI.

| OAuth `error` | Client action |
| --- | --- |
| `authorization_pending` | Wait the current interval and poll again. |
| `slow_down` | Add five seconds to the interval for **all subsequent** polls. |
| `access_denied` | Stop; show that authorization was declined. |
| `expired_token` | Stop; offer a new user-initiated attempt with a new code. |
| Anything else | Stop this attempt and preserve status, error, and correlation ID. |

Stop at the response's absolute deadline, on user cancellation, or after a terminal
error. On connection timeouts, reduce request frequency (for example exponential
backoff); never run overlapping polling loops. Do not automatically restart an
expired or denied flow. HTTP 400 is normal for pending/slow-down responses: parse
the OAuth `error` before deciding whether to terminate.

Confidential clients send a **fresh** `private_key_jwt` assertion on the start
request and every poll. Use `iss=sub=client_id`, current numeric `iat`, `exp` at
most 300 seconds later, a unique `jti`, registered `kid`/algorithm, and
`client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`.
The assertion's `aud` is the exact **device authorization endpoint** on start and
the exact **token endpoint** on polling. Revocation also uses token-endpoint `aud`.

## Validate and finish the actual service login

A successful token response uses the normal Identity token set: `access_token`,
`token_type: Bearer`, `expires_in`, `scope`, `id_token`, and optionally a rotating
`refresh_token` when `offline_access` was granted.

Use a maintained OIDC/JOSE library. Validate ID-token RS256 signature using the
issuer-discovered JWKS, exact `iss`, `aud == client_id`, `exp`, `iat`, `sub`, and
Identity's ID-token discriminator `token_use=id`. An access token has
`token_use=access` and must not establish the session as an ID token.
This grant does not issue a nonce; do not apply an authorization-code transaction's
nonce check to it. Key the service account by `(issuer, sub)`, not username/email.
For API bearer use additionally require `token_use=access`, the exact intended
`client_id` audience, and required scopes; an ID token is not an access token.

Persist tokens in protected application storage before announcing successful
service login. For a remote backend, store them server-side and establish a local
HttpOnly application session; do not return Identity tokens to an unrelated
browser. Serialize refresh per local session and atomically replace rotated token
sets. Revoke refresh material through discovery's revocation endpoint on sign-out.
See [OIDC lifecycle and validation](oidc-integration.md) for shared behavior.

The portable helper in this skill's `scripts/device-login.mjs` performs public
native-client login and validates the ID token. From the consuming project root,
set `IDENTITY_SKILL` to this installed skill directory, then run:

```bash
mkdir -p .temp
node "$IDENTITY_SKILL/scripts/device-login.mjs" \
  --issuer https://identity-staging.moesegfault.dev \
  --client-id remote-console-staging \
  --output .temp/identity-tokens.json \
  --scope 'openid profile offline_access'
```

Create the output inside the consuming project's protected runtime directory;
`.temp` above is an example for local integration only. Do not commit token files.
The helper creates a new mode-0600 file and does not overwrite an existing token
set. Application-specific persistence, refresh coordination, local session creation,
and confidential-client assertions remain the consuming service's responsibility.

## Acceptance journey

Exercise one real remote-terminal → browser sign-in → compare client/code → explicit
approval → token validation → protected local-session journey. Repeat with denial,
expiry, an early poll, wrong client, and consumed-code replay. A browser completion
page confirms approval, not that the remote service has validated/persisted tokens.
Check that existing callback/PKCE login and refresh behavior remains unchanged.
Preserve correlation IDs and OAuth errors in diagnostics without storing device
codes, assertions, tokens, browser cookies, or complete verification links.

## Protocol basis

- [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html): device requests, polling,
  backoff, and separate human/device codes.
- [RFC 10027](https://www.rfc-editor.org/rfc/rfc10027.html): cross-device consent
  phishing and practical mitigations. Genuine Identity sign-in, even with a
  Passkey, does not prove that the requester owns the remote device.
