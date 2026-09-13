# Identity 发布与回滚手册 / Release and rollback runbook

## 资源与边界 / Resources and boundaries

| 单元 | 公网域名 | 状态 |
| --- | --- | --- |
| Rust Identity Worker | `identity.moesegfault.dev` | production D1 `b3f4a7dd-4415-417d-a1eb-47c36a47ad24` + private R2 `moesegfault-identity-audit-production` + UTC cron |
| TypeScript Login Static Assets Worker | `login.moesegfault.dev` | 无 D1/R2；仅静态资产 |

`wrangler.identity.jsonc` 与 `wrangler.login.jsonc` 中的自定义域名（Custom Domain）是 DNS/证书调和的唯一事实源。日常 CI 不直接更改 DNS 记录。

## 首次引导 / One-time bootstrap

1. 手动运行 GitHub Actions **Cloudflare bootstrap**。
2. 工作流重复执行是幂等的：已存在资源只验证，不重建。
3. 若 D1 同名资源的 UUID 与配置不同，工作流会停止；必须用 PR 审查资源替换，不会在 CI 中偷改仓库。
4. GitHub Environment `cloudflare-deployment` 应限制为 `main`，并配置 required reviewer。
5. 首次 Identity Worker 建立后，对 production 和 staging 分别设置 `REGISTRATION_PEPPER`、`RECOVERY_CODE_PEPPER`、`TRANSACTION_PEPPER`、`TRANSACTION_STATE_KEY`、`SESSION_PEPPER` 与 `CSRF_PEPPER`；重跑 bootstrap 会验证 production 密钥名称。`TRANSACTION_STATE_KEY` 必须是 32-byte 随机 key 的无填充 Base64URL 编码。
6. OAuth 默认关闭。启用前必须设置 `AUTHORIZATION_CODE_PEPPER`、`REFRESH_TOKEN_PEPPER`、`PAIRWISE_SUBJECT_KEY`、`OIDC_PRIVATE_KEY_PKCS8`，把 `PUBLIC_JWKS` 替换为包含 `OIDC_ACTIVE_KID` 的 RSA/RS256 公钥，最后才将 `OAUTH_ENABLED` 设为 `true`。

Cloudflare token 最小权限：Workers Scripts Write、Workers Routes Write、D1 Edit；仅 bootstrap 需 Workers R2 Storage Write。使用 Custom Domain 时不应为日常发布 token 增加普通 DNS Write。

## 正常发布 / Normal release

`main` 的 CI 全部通过后，发布 job 使用同一工作流中上传的已测试制品：

```text
local D1 migration -> identity/login dry-run
-> production D1 migration -> identity deploy -> login deploy -> public smoke
```

生产发布使用串行 concurrency group，不取消正在运行的发布。迁移必须使用扩展—迁移—收缩（expand–migrate–contract）模式：先增加兼容 schema，再发布代码，最后在后续版本删除旧 schema。

## 故障与回滚 / Incident and rollback

1. 使用 `npx wrangler versions list --env production --config <config>` 确认两个 Worker 的目标 version ID。
2. 手动运行 **Rollback production**，填入 identity/login version ID 和理由。
3. 工作流调用 `scripts/rollback.sh`，先恢复 login，后恢复 identity，再执行公网冒烟检查。
4. **Worker 回滚不回滚 D1/R2**。不得为了匹配旧代码直接恢复旧数据库快照；那可能复活已撤销凭据。数据恢复必须遵循设计文档的 `recovery_lockdown` 与审计重放程序。

## 定时任务 / Cron

production 每 5 分钟触发一次（UTC），用于排空持久 outbox。Cron 配置只由 Wrangler 管理。当前 `workers-rs` 宏可能丢弃 scheduled handler 的 Rust `Result`；任务不得依赖返回 `Err` 作为唯一失败信号，必须显式记录并保留可重试状态。
