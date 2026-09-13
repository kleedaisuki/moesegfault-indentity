# Identity 配置 / Identity Configuration

本文定义 `moesegfault-identity` 首期运行配置的名称、所有权与轮换边界。值示例不是生产秘密。

This document defines first-release runtime configuration names, ownership, and rotation boundaries. Example values are not production secrets.

## 非秘密变量 / Non-secret Variables

| 变量 / Variable | 生产值 / Production value | 契约 / Contract |
| --- | --- | --- |
| `ISSUER` | `https://identity.moesegfault.dev` | 必须与 discovery、JWT `iss` 完全一致。 |
| `LOGIN_ORIGIN` | `https://login.moesegfault.dev` | CORS、Origin 与 WebAuthn expected origin 的唯一生产值。 |
| `WEBAUTHN_RP_ID` | `login.moesegfault.dev` | 不得扩大到 `moesegfault.dev`。 |
| `ENVIRONMENT` | `production` | 有限枚举；进入日志/Diagnostic 的低基数字段。 |
| `SESSION_IDLE_SECONDS` | `43200` | 新 Identity Session 12 小时 idle TTL。 |
| `SESSION_ABSOLUTE_SECONDS` | `2592000` | 新 Identity Session 30 天 absolute TTL。 |
| `RECENT_AUTH_SECONDS` | `300` | 高风险操作 Passkey step-up 窗口。 |
| `TRANSACTION_TTL_SECONDS` | `300` | WebAuthn、Binding 与 Recovery transaction TTL。 |
| `AUTHORIZATION_CODE_TTL_SECONDS` | `60` | Authorization Code 最大寿命。 |
| `TOKEN_TTL_SECONDS` | `300` | ID/Access Token 最大寿命。 |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh family 绝对寿命。 |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` | Domain API idempotency metadata 保留时间。 |
| `PUBLIC_JWKS` | 部署生成的 JWK Set | Bootstrap 期间的公钥投影；必须与 `signing_keys` 中可发布 key 一致。 |

这些值是“新签发对象”的策略。收紧配置不得回写已有对象的 `expires_at`；紧急处置使用显式撤销。

These values govern newly issued objects. Tightening policy must not rewrite an existing object's original expiry; emergency handling uses explicit revocation.

## Cloudflare Bindings

| Binding | 类型 / Type | 用途 / Purpose |
| --- | --- | --- |
| `DB` | D1 | 身份、OAuth、audit 和 outbox 的唯一关系型权威。 |
| `AUDIT_ARCHIVE` | R2 | 以 `audit_event_id` 派生的确定性对象键归档安全审计。 |
| `STATUS` | Service Binding | 异步提交去标识化 Diagnostic；故障不得阻塞认证。 |

D1 迁移位于 `migrations/`，必须使用 database name（而不是易变 binding name）执行远端迁移。生产正确性读使用 primary-first D1 Session/bookmark；KV 不得承担 credential、transaction、session、revocation、Binding 唯一性或幂等权威。

## Workers Secrets

| Secret | 用途 / Purpose | 轮换后果 / Rotation consequence |
| --- | --- | --- |
| `BROWSER_CONTEXT_PEPPER` | Browser cookie digest 与 CSRF 派生隔离。 | 使匿名 browser context 失效。 |
| `SESSION_PEPPER` | Identity Session cookie HMAC digest。 | 使所有 Identity Session 失效。 |
| `TRANSACTION_PEPPER` | challenge/browser/state 等一次性摘要。 | 使所有未完成 transaction 失效。 |
| `RECOVERY_CODE_PEPPER` | Recovery code HMAC-SHA-256。 | 使所有既有 recovery code 失效。 |
| `REGISTRATION_PEPPER` | 一次性注册 capability HMAC。 | 使未消费 capability 失效。 |
| `AUTHORIZATION_CODE_PEPPER` | Authorization Code digest。 | 使未消费 code 失效。 |
| `REFRESH_TOKEN_PEPPER` | Refresh Token digest。 | 使全部 refresh family 失效。 |
| `PAIRWISE_SUBJECT_KEY` | 按 sector 派生 OIDC pairwise `sub`。 | 必须版本化；盲目轮换会改变客户端看到的 `sub`。 |
| `BINDING_PKCE_AEAD_KEY_V1` | 短期加密 provider PKCE verifier。 | 旧 key 保留到所有相关 transaction 过期并清理。 |
| `OIDC_SIGNING_KEY_<KID>` | 与 `signing_keys.secret_binding_name` 对应的 RS256 私钥。 | 按 publish→activate→retire→remove 顺序轮换。 |
| `STATUS_DIAGNOSTIC_PRIVATE_KEY` | 为 status Diagnostic 签发独立短寿命机器 JWT。 | 只影响 outbox drain；不得影响登录。 |

不得复用 pepper、签名钥、provider secret、Cloudflare API Token 或 `ops` 管理员密钥。Provider client secret 也必须以独立 Workers Secret 配置，命名 `BINDING_PROVIDER_<PROVIDER_ID>_CLIENT_SECRET`。

## Bootstrap 与部署配置 / Bootstrap and Deployment-owned Configuration

以下内容通过受审查的部署步骤写 D1，并同时产生 `security_audit_events` 与 archive outbox；不提供普通账号 HTTP 管理面：

- 单例 `registration_policy`（默认 `invite_only`）及一次性 capability；
- `binding_providers` 及 provider client metadata；
- `oauth_clients`、public keys、redirect/post-logout URI 与 scope grants；
- `signing_keys` 的公开 JWK 和状态（私钥仍在 Secret）。

Configuration changes must be deterministic and idempotent. Exact redirect URI rows must not contain `*`; native loopback variable ports use `match_mode=native_loopback_any_port` only for `127.0.0.1` or `[::1]`.

## 迁移与验证 / Migration and Verification

```bash
# Local schema verification / 本地模式验证
npx wrangler d1 migrations apply moesegfault-identity-staging --local --config wrangler.identity.jsonc
sqlite3 :memory: ".read migrations/0001_identity_foundation.sql" "PRAGMA foreign_key_check;" "PRAGMA integrity_check;"

# Production is a reviewed deployment step / 生产为受审查部署步骤
npx wrangler d1 migrations apply moesegfault-identity-production --remote --env production --config wrangler.identity.jsonc
```

每次发布还必须 lint `openapi/identity.yaml`、检查实现路由与 contract route 集合一致，并测试同一 transaction/code/token 的并发双消费只有一个成功。
