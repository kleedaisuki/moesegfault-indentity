# moeSegFault Login SPA

## 内联 Passkey 再认证

增加/撤销 Passkey、建立/解除 Identity Binding 和轮换恢复码等高风险操作以服务端的近期认证策略为准。首次请求如果返回结构化错误 `reauthentication_required`，前端会在当前页面中：

1. 以 `purpose=step_up` 创建认证事务；
2. 请求一次 WebAuthn assertion；
3. 完成事务并用服务端返回的新 CSRF token 替换页面内状态；
4. 使用**新幂等键**重试原操作一次。

前端不对普通 `403` 猜测再认证语义，也不无限重试。同页并发请求共享一次 ceremony，避免重叠的浏览器提示。

CSRF token、ceremony transaction、assertion 和恢复码均不写入 `localStorage`、`sessionStorage`、IndexedDB 或 Service Worker cache。它们只存在于当前 JavaScript Realm，恢复码仅在用户明确复制或下载时离开内存。

## Inline passkey step-up

High-risk operations such as adding/revoking a passkey, establishing/removing an Identity Binding, and rotating recovery codes defer recent-authentication policy to the server. When the first attempt returns the structured `reauthentication_required` code, the SPA:

1. starts an authentication transaction with `purpose=step_up`;
2. obtains a WebAuthn assertion;
3. completes the transaction and replaces the in-memory CSRF token with the server result; and
4. retries the original operation once with a **fresh idempotency key**.

The client never guesses step-up semantics from a generic `403` and never retries indefinitely. Concurrent requests in the same page share one ceremony to avoid overlapping browser prompts.

CSRF tokens, ceremony transactions, assertions, and recovery codes are never written to `localStorage`, `sessionStorage`, IndexedDB, or a Service Worker cache. They exist only in the current JavaScript realm; recovery codes leave memory only when the user explicitly copies or downloads them.

## Verification / 验证

```shell
npm run typecheck --workspace=@moesegfault/login
npm run test --workspace=@moesegfault/login -- --run
npm run build --workspace=@moesegfault/login
```
