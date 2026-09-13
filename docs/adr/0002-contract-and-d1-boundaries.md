# ADR-0002：HTTP 契约与 D1 边界 / HTTP Contract and D1 Boundaries

- 状态 / Status: Accepted
- 日期 / Date: 2026-09-13

## 决策 / Decisions

1. `openapi/identity.yaml` 是公网 HTTP 表面的唯一事实来源，使用 OpenAPI 3.1.1 与 JSON Schema 2020-12；领域 JSON 字段为 `snake_case`。
2. 普通领域 API 错误使用 RFC 9457 `application/problem+json`。OAuth token/revocation 保留 OAuth error JSON，UserInfo 保留 RFC 6750 challenge，浏览器 authorization/logout 保留 redirect 语义；不能为了“统一”破坏协议客户端。
3. Login SPA 先调用 `GET /v1/browser-context`，取得 HttpOnly browser cookie 与仅驻内存的 CSRF token。认证建立或轮换 session 后响应新的 session-bound CSRF token。
4. OAuth authorization code 绝不返回 Login JavaScript。认证完成只返回 Identity 固定域的 resume URI；顶层导航到 resume endpoint 后才 302 到精确登记的 client redirect URI。
5. D1 保存关系型权威事实和 secret digest；Provider PKCE verifier 是例外，因为 callback 必须取回原值换 token，所以仅短期保存独立密钥加密的 AEAD ciphertext/nonce/key revision，消费后由清理任务删除。
6. Refresh Token 每一代均保留摘要行直至 family 过期，以检测旧 token 重用。签名私钥、HMAC pepper、AEAD key 均不进入 D1。
7. Security audit 追加不可变；Diagnostic 和 R2 archive outbox 的事件身份/payload 不可变，仅投递状态可更新。

## OAuth 首期边界 / OAuth First-release Boundary

| 能力 / Capability | 首期 / First release |
| --- | --- |
| Grant | Authorization Code + PKCE S256、Refresh Token rotation |
| Client | 部署静态登记的 confidential BFF 与 native client；无动态注册 |
| Client auth | `private_key_jwt`（confidential）或 `none`（预登记 native） |
| Subject | 按 sector 的 pairwise subject；不暴露 `principal_id` |
| Token algorithms | ID/Access Token `RS256`，带固定 issuer 与 `kid` |
| Consent | 只允许部署授予的最小 scope；通用用户 consent UI 延后 |
| Revocation | Refresh family 立即撤销；短寿命 self-contained access token 为 best effort |

## 数据建模结果 / Data-model Consequences

- UUIDv4 `principal_id` 与 UUIDv7 管理/事件 ID 均保存为 `TEXT`；摘要、公钥与 credential ID 保存为 `BLOB`；时间使用 UTC Unix 秒 `INTEGER`。
- 外键一律 `ON DELETE RESTRICT`，因为 lifecycle deletion、审计引用与撤销不能被级联物理删除静默吞掉。
- SQLite 不会为普通外键自动建索引；迁移显式覆盖 credential/session/token/outbox 的高频访问路径。
- OAuth redirect URI 是逐行精确登记；native loopback 的“任意端口”是显式 match mode，不是字符串 wildcard。
- R2 archive 的“不覆盖”还依赖条件写、确定性 object key 与最小权限 Binding；D1 约束不能单独提供 WORM（Write Once Read Many）语义。

## 延后事项 / Deferrals

- 动态 client/provider 管理 API、Email identifier、账号合并、通用 workload token grant。
- Avatar 上传/裁剪 API；D1 仅预留 R2 object key，首期 profile mutation 不接受 avatar。
- Access Token introspection 与即时 denylist；五分钟最大 TTL 是当前撤销窗口。
- 自动物理清理、审计保留年限和 D1→R2 删除证明；上线前必须另行确定数据治理策略。

## 依据 / Evidence

- [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)
- [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html)
- [RFC 9700 OAuth 2.0 Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html)
- [OpenID Connect RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)

