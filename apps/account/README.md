# moeSegFault Account

`account.moesegfault.dev` is the private, authenticated account-management SPA. It intentionally does not own login, registration, recovery, OAuth consent, or WebAuthn ceremonies; those remain on `login.moesegfault.dev`, whose origin matches the WebAuthn relying-party ID.

## Routes

- `/` — expressive account overview
- `/profile` — avatar, profile, locale, timezone, email, and international mobile contacts
- `/security` — password, passkeys, future MFA, and recovery posture
- `/sessions` — active Identity sessions
- `/apps` — OAuth/OIDC grants

## Runtime contract

The SPA uses cookie-authenticated `/v1/me` APIs with `credentials: include`, `cache: no-store`, RFC 9457 errors, in-memory CSRF tokens, and idempotency keys on mutations. Passkey enrollment and recovery rotation perform top-level navigation to Login's `/passkey/enroll` and `/recovery-codes/rotate` ceremonies with a validated `return_uri`, instead of attempting cross-origin WebAuthn. Existing Passkey labels and revocations remain account-management operations here.

Only non-sensitive theme and language preferences are persisted in `localStorage`; cookies and CSRF material are never stored by JavaScript.

## Development

```sh
npm run dev --prefix apps/account
npm run typecheck --prefix apps/account
npm run test --prefix apps/account
npm run build --prefix apps/account
```

Visuals follow the warm editorial tokens and official brand geometry from [`moesegfault-style`](https://github.com/kleedaisuki/moesegfault-style). All functional icons are local SVG symbols, so the account surface loads no third-party scripts or fonts.
