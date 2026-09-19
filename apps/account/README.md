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
