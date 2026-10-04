# moeSegFault Account

`account.moesegfault.dev` is the private, authenticated account-management SPA. It intentionally does not own login, registration, recovery, OAuth consent, or WebAuthn ceremonies; those remain on `login.moesegfault.dev`, whose origin matches the WebAuthn relying-party ID.

## Routes

- `/` — expressive account overview
- `/profile` — avatar, profile, locale, timezone, email, and international mobile contacts
- `/security` — password, passkeys, future MFA, and recovery posture
- `/sessions` — active Identity sessions
- `/apps` — OAuth/OIDC grants
- `/subscriptions` — Subscribe-owned subscription status, expiry, and activation-code management

The `/sessions` response includes active sessions and revoked sessions retained for 30 days.
Account renders `revoked_at` as signed-out history with the revocation time, without another
sign-out action. Active non-current sessions retain the sign-out action; the current session
retains its current-device badge. An omitted or null `revoked_at` remains compatible with
older responses. Successful mutations reread the authoritative server state.

## Runtime contract

The SPA uses cookie-authenticated `/v1/me` APIs with `credentials: include`, `cache: no-store`, RFC 9457 errors, in-memory CSRF tokens, and idempotency keys on mutations. Passkey enrollment and recovery rotation perform top-level navigation to Login's `/passkey/enroll` and `/recovery-codes/rotate` ceremonies with a validated `return_uri`, instead of attempting cross-origin WebAuthn. Existing Passkey labels and revocations remain account-management operations here.

Only non-sensitive theme and language preferences are persisted in `localStorage`; cookies and CSRF material are never stored by JavaScript.

Contact routes use the `contact_id` returned by `/v1/me/contacts`. The API client also accepts the older deployed `identifier_id` response shape during staggered rollout, normalizes it before UI rendering, and rejects a missing ID before constructing a mutation URL. The server must still authorize ownership; this client-side check only prevents misleading `/contacts/undefined` requests.

## Session rendering contract

The browser models the session as one discriminated state: `pending`, `anonymous`, or `authenticated`. Account data, server preferences, and the CSRF token enter memory together only in the authenticated state. The shell starts with authenticated navigation, the user chip, and in-app guidance hidden, so neither startup nor deep links flash misleading controls. Every API `401` moves the whole shell to `anonymous`; transport and other HTTP failures retain a retry action.

The anonymous state is a dedicated public introduction rather than an error card. It presents the
profile, sign-in, session, and authorization value of Account Center, keeps Login as the primary
deep-link-aware action, and pairs a secondary registration link to the same environment.

浏览器使用一个判别联合表示会话：`pending`、`anonymous` 或 `authenticated`。账号数据、服务端偏好和 CSRF token 只会在已鉴权状态中一起进入内存。外壳初始即隐藏鉴权导航、用户卡片和应用内提示，因此首次加载和深链接都不会闪现误导控件。任意 API `401` 都会将整个外壳切换为匿名状态；网络错误和其他 HTTP 错误仍可重试。

匿名状态是一张独立的公开介绍页，而不是错误卡片。它说明资料、登录、会话与授权管理的价值；登录是保留当前深链接的主操作，创建账号是与当前环境严格配对的次操作。资料页选择头像后会先生成并预览最终方形产物，显示尺寸与体积，只有明确确认后才上传；取消、替换、上传完成或离页都会释放本地预览资源。

## Development

```sh
npm run dev --prefix apps/account
npm run typecheck --prefix apps/account
npm run test --prefix apps/account
npm run build --prefix apps/account
```

Visuals follow the warm editorial tokens and official brand geometry from [`moesegfault-style`](https://github.com/kleedaisuki/moesegfault-style). All functional icons are local SVG symbols, so the account surface loads no third-party scripts or fonts.

## Subscription integration boundary

The dedicated subscription section embeds the fixed paired Subscribe `/account` viewer. Its
session is owned by Subscribe, not by this Account SPA. Identity emits a pairwise OIDC `sub`;
Account's `principal_id` is deliberately not sent or equated with that subject. The page asks
users to check the subscription account displayed by the viewer. Reconnect starts a fresh
top-level Subscribe Authorization Code transaction and offers the exact Account
`/subscriptions` return destination. No OAuth token, Identity cookie, or CSRF proof is passed
through iframe parameters or browser messages.

The iframe receives only `embedded=1`, a supported locale, and the effective light/dark theme.
Account CSP permits only the production and staging Subscribe origins; Subscribe must limit
`frame-ancestors` to its paired Account origin. Sandbox permits scripts, the viewer's own
origin/session, and user-activated top-level navigation, not arbitrary forms or popups.
A persistent top-level manage link remains available if browser cookie/frame policy prevents
loading the viewer. Account logout and Subscribe logout remain distinct.

Staging acceptance: redeem a code in Subscribe, open Account `/subscriptions`, verify the
viewer account label and activated plan/expiry, then exercise reconnect and the Account
return link. Switching Identity accounts must never silently relabel a retained Subscribe
session as belonging to the new Account principal.

Reference: [MDN CSP frame-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-src)
distinguishes the parent's allowed frame destinations from the child's allowed ancestors.
