# moeSegFault Login SPA

`login.moesegfault.dev` 只负责认证和账号创建：密码与 Passkey 是并列选项。资料、安全方式、会话与未来的 2FA 管理由 `account.moesegfault.dev` 承担，登录站不再提供账号管理路由。GitHub 等联合登录将在 Identity 提供匿名联合认证契约后通过能力发现启用；当前不会把“账号绑定”错误伪装成登录。

The login origin only authenticates and creates accounts. Password and Passkey are alternatives; profile, security methods, sessions, and future 2FA management belong to the separate Account application. Federated login will be capability-discovered after Identity exposes an anonymous federation contract; account linking is deliberately not misrepresented as sign-in.

## Frontend contract / 前端契约

- `POST /v1/password/registrations` 创建密码账号与初始会话；
- `POST /v1/password/authentications` 以邮箱或用户名登录；
- existing WebAuthn transaction endpoints remain the optional Passkey flow;
- OAuth authorization transaction handles are held in memory and forwarded to every login method;
- UI language (`zh-CN`, `en`, `ja`) and theme are the only values persisted locally. Credentials and CSRF material are never persisted.

Account Center may invoke two narrow Login-owned ceremonies:

- `/passkey/enroll?return_uri=…` adds one authenticator;
- `/recovery-codes/rotate?return_uri=…` performs required step-up and rotates recovery codes.

`return_uri` is accepted only when its origin exactly matches the Account origin paired with the current Login environment. These pages never list, rename, revoke, or otherwise manage account resources. Newly issued recovery codes are shown before any onward navigation and can be copied or downloaded once.

Passkey enrollment keeps Passkey step-up as the primary recent-authentication path. A password-only account can instead expand the localized password fallback, refresh its recent session, and create its first Passkey; a failed password check never starts a registration ceremony.

The visual system derives its warm cream/coral/gold palette, glass treatment, brand SVG, typography stack, and spacing approach from the maintainer's `moesegfault-style` repository. All icons are local SVG; the login page makes no visual CDN requests.

## 内联 Passkey 再认证

增加/撤销 Passkey、建立/解除 Identity Binding 和轮换恢复码等高风险操作以服务端的近期认证策略为准。首次请求如果返回结构化错误 `reauthentication_required`，前端会在当前页面中：

1. 以 `purpose=step_up` 创建认证事务；
2. 请求一次 WebAuthn assertion；
3. 完成事务并用服务端返回的新 CSRF token 替换页面内状态；
4. 使用**新幂等键**重试原操作一次。

前端不对普通 `403` 猜测再认证语义，也不无限重试。同页并发请求共享一次 ceremony，避免重叠的浏览器提示。如果其他标签页轮换了共享 session cookie，精确的 CSRF 验证错误会让当前标签页刷新内存 CSRF，并仅重试一次。

CSRF token、ceremony transaction、assertion 和恢复码均不写入 `localStorage`、`sessionStorage`、IndexedDB 或 Service Worker cache。它们只存在于当前 JavaScript Realm，恢复码仅在用户明确复制或下载时离开内存。

## Inline passkey step-up

High-risk operations such as adding/revoking a passkey, establishing/removing an Identity Binding, and rotating recovery codes defer recent-authentication policy to the server. When the first attempt returns the structured `reauthentication_required` code, the SPA:

1. starts an authentication transaction with `purpose=step_up`;
2. obtains a WebAuthn assertion;
3. completes the transaction and replaces the in-memory CSRF token with the server result; and
4. retries the original operation once with a **fresh idempotency key**.

The client never guesses step-up semantics from a generic `403` and never retries indefinitely. Concurrent requests in the same page share one ceremony to avoid overlapping browser prompts. If another tab rotates the shared session cookie, an exact CSRF-validation response causes this tab to refresh its in-memory CSRF value and retry once.

CSRF tokens, ceremony transactions, assertions, and recovery codes are never written to `localStorage`, `sessionStorage`, IndexedDB, or a Service Worker cache. They exist only in the current JavaScript realm; recovery codes leave memory only when the user explicitly copies or downloads them.

## Verification / 验证

```shell
npm run typecheck --workspace=@moesegfault/login
npm run test --workspace=@moesegfault/login -- --run
npm run build --workspace=@moesegfault/login
```
