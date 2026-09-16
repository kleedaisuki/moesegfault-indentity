# Identity 平台 SRE 手册 / Identity platform SRE runbook

> 本手册描述 `identity`、`login`、`account` 三个独立发布单元。身份 API 是权威；登录与账号管理是可独立回滚的静态前端。
> This runbook covers three independently deployable units. Identity is authoritative; login and account are independently reversible static frontends.

## 拓扑与责任边界 / Topology and ownership

| 单元 | Staging | Production | 持久状态 |
| --- | --- | --- | --- |
| Identity Worker | `identity-staging.moesegfault.dev` | `identity.moesegfault.dev` | D1 + private audit R2 |
| Login assets | `login-staging.moesegfault.dev` | `login.moesegfault.dev` | 无 / none |
| Account assets | `account-staging.moesegfault.dev` | `account.moesegfault.dev` | 无 / none |
| Verification email | `identity@moesegfault.dev` | `identity@moesegfault.dev` | Cloudflare Email Service |

Cron、bindings 与非敏感变量的唯一事实源（single source of truth）是三个 `wrangler.*.jsonc`；Custom Domains 与 Email Sending 域名则由 `scripts/bootstrap-cloudflare.sh` 幂等调和。密钥只用 `wrangler secret put` 管理。域名生命周期与应用发布分开，日常 CI 无需 zone-level Workers Routes 权限。

## 首次引导 / Bootstrap

1. 建立 GitHub Environments `cloudflare-staging` 与 `cloudflare-production`；production 限制为 `main` 并要求人工审批，两个环境分别保存 Cloudflare 凭据。
2. 为 staging 与 production 各手动运行一次 **Cloudflare bootstrap**。它验证固定的 D1 UUID、幂等创建私有 audit/avatar R2、调和 Worker/R2 Custom Domains、接入 `moesegfault.dev` 到 Cloudflare Email Sending、关闭邮件 Activity Log 的完整正文预览，并检查所选环境的密钥名称。邮件域名是两个环境共享的 zone 资源，重复运行安全。
3. 对两个 Identity 环境设置 `REGISTRATION_PEPPER`、`RECOVERY_CODE_PEPPER`、`CONTACT_VERIFICATION_PEPPER`、`EMAIL_OUTBOX_KEY_V1`、`TRANSACTION_PEPPER`、`TRANSACTION_STATE_KEY`、`SESSION_PEPPER`、`CSRF_PEPPER`。`EMAIL_OUTBOX_KEY_V1` 与 `TRANSACTION_STATE_KEY` 均为独立生成的 32-byte 随机值，使用无填充 Base64URL；前者用于持久邮件 outbox 的静态加密（encryption at rest），不可与 pepper 或其他环境复用。
4. OAuth/OIDC 启用时还需 `AUTHORIZATION_CODE_PEPPER`、`REFRESH_TOKEN_PEPPER`、`PAIRWISE_SUBJECT_KEY`、`OIDC_PRIVATE_KEY_PKCS8`，并确认 `PUBLIC_JWKS` 的 `kid` 与 `OIDC_ACTIVE_KID` 一致。

日常发布 token 需要 Workers Scripts Write 与 D1 Edit；不需要 zone-level Workers Routes。bootstrap 额外需要 R2 Storage Write、Email Sending Edit 与 Zone Read，并使用相同的 Workers Scripts Write 权限调用 account-level Custom Domains API。Email Sending 接入由固定版本 Wrangler 调用 Email Service API，Cloudflare 自动管理 bounce MX、SPF、DKIM 与 DMARC DNS 记录；不要在脚本中复制这些易漂移的记录。新 sending domain 默认启用 Email Preview，会在 Activity Log 暂存完整邮件；验证码属于认证秘密，所以 bootstrap 使用官方 update/get API 将 `preview_enabled` 持续调和为 `false` 并回读验证。GitHub Environment 在审批通过前不会向 job 暴露 secrets，这是生产提升边界，而不是把正常边界情况推回用户。[GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments) [Cloudflare Email Sending domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/) [Cloudflare Email Sending API](https://developers.cloudflare.com/api/resources/email_sending/)

## 发布流水线 / Release pipeline

```text
Rust + frontend matrix + contracts/migrations
             │
             ▼
 Wrangler dry-runs → checksummed immutable bundle
             │
             ▼
 staging secrets → migration → identity → login → account → smoke
             │
             ▼ protected approval
 production secrets → migration → identity → login → account → smoke
```

CI 对同一个制品做 staging 与 production 提升，不在环境间重建。`concurrency` 串行化每个环境，production job 还会拒绝覆盖更新的 `main`。质量门禁（quality gate）应设为 branch protection 的 required check。

### 数据迁移规则 / Migration rules

1. **Expand**：只增加 nullable column/table/index 或双写所需结构；旧 Worker 必须继续工作。
2. **Migrate**：部署兼容代码，后台回填；用指标确认旧/新读路径一致。
3. **Contract**：至少一个独立发布之后，确认回滚窗口已关闭，才移除旧结构。

D1 迁移在 Worker 前执行，所以“新 schema + 旧 code”必须安全。禁止把破坏性 schema 修改与依赖它的新代码放在同一发布。Cloudflare 明确指出 Worker rollback 不恢复绑定资源与数据结构。[Cloudflare rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

## 可观测性契约 / Observability contract

Workers Logs 与 Traces 在部署前即开启；低流量阶段 logs 100%、traces 10%。容量或费用变化时按观测数据调整，而不是关闭观测。Cloudflare 建议生产 Worker 在发布前启用日志和追踪，并使用 sampling 控制容量。[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

应用结构化日志（structured logging）字段约定：

| 字段 | 语义与约束 |
| --- | --- |
| `timestamp`, `level`, `event` | UTC 时间、severity、稳定的低基数事件名 |
| `request_id`, `trace_id` | 跨 identity/login/account 与下游关联；响应回传 request ID |
| `service`, `environment`, `version` | 发布维度，必须能按 version 对比错误率 |
| `route`, `method`, `status`, `duration_ms` | route 使用模板，禁止把 user ID 放进 metric label |
| `subject_hash`, `client_id` | 仅在确有诊断需要时记录不可逆 hash；不记录密码、token、cookie、验证码、手机号或 email |
| `outcome`, `error_code`, `dependency` | 稳定枚举；异常 stack 进入 error event |

追踪（distributed tracing）应覆盖 D1/R2/service binding 与关键认证阶段；自定义 span 只记录阶段和结果，不记录凭据。Cloudflare Traces 遵循 OpenTelemetry（OTel），可导出至兼容后端。[Workers traces](https://developers.cloudflare.com/workers/observability/traces/)

## SLI、SLO 与告警 / SLIs, SLOs, and alerts

初始 30 天滚动目标是待流量验证的工程假设，而非既成事实：

| 用户旅程 / SLI | 初始 SLO | Good event 定义 |
| --- | ---: | --- |
| Identity API availability | 99.9% | 非预期 5xx 之外的有效响应；明确的用户输入 4xx 算 good |
| Login page availability | 99.9% | synthetic GET 得到有效 HTML，关键 asset 可加载 |
| Account page availability | 99.9% | synthetic GET 得到有效 HTML，关键 asset 可加载 |
| OIDC token latency | 99% < 750 ms | edge 测得完整 token 请求耗时 |
| Interactive auth completion | 99% < 5 s | 从 transaction 创建到成功 session；按方法分组但不含身份 PII |
| Audit outbox freshness | 99.9% < 10 min | oldest pending item age 小于阈值 |

分页（page）采用多窗口多燃烧率（multi-window multi-burn-rate）：1h/5m 都超过 14.4× 或 6h/30m 都超过 6×；3d 超过 1× 建 ticket。低流量时单次失败会夸大比例，需同时要求最小事件数，并保留独立 synthetic availability 告警。阈值来自 Google SRE Workbook 的推荐起点，应按真实流量与值班能力校准。[Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)

### 仪表盘 / Dashboard

按 environment/service/version 展示：request rate、unexpected 5xx、p50/p95/p99 latency、D1/R2 error/latency、OAuth error code、login method success、outbox depth/age、Cron last success、deployment annotation、各 SLO error-budget remaining。不得用高基数用户属性做 metric dimension。

## 冒烟检查与事故响应 / Smoke checks and incident response

`scripts/smoke.sh <staging|production>` 验证：Identity deep health（含 D1）、OIDC discovery 契约、Login/Account HTML。它是部署后 gate，不代替持续外部 synthetic monitoring。

事故处理：

1. **Triage**：确认用户影响、环境、首个异常时间与当前 version；用 request/trace ID 关联，不先重启或清日志。
2. **Mitigate**：若新版本相关且 schema 向后兼容，执行 rollback；依赖故障则保留诊断信号并采取降级。
3. **Verify**：运行 smoke，观察至少两个短告警窗口；确认 error-budget burn 恢复。
4. **Communicate**：记录时间线、影响的用户旅程、当前缓解状态与下一次更新时间。
5. **Learn**：无责复盘（blameless postmortem），补充测试、runbook 或 SLO；保留反证和未确定原因。

## 回滚 / Rollback

1. 分别运行 `npx wrangler versions list [--env production] --config wrangler.<unit>.jsonc`，选定三个已知健康 version ID。
2. 手动运行 **Rollback production**，选择环境、填写 identity/login/account version ID 与可审计理由。
3. 工作流先恢复 Account/Login，再恢复 Identity，随后运行该环境 smoke。
4. **不回滚 D1/R2**。若旧代码不兼容当前数据，保持新 Worker 并用向前修复（roll-forward）；不得直接恢复数据库快照，因为这可能复活已撤销 session/credential。

Cloudflare rollback 会把目标 version 立即恢复至 100% 流量，而且只能选择最近 100 个版本；因此 release artifact 保留 30 天，事故前先核对目标版本和 binding 仍存在。[Cloudflare rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

## Cron 与日常检查 / Cron and routine checks

Production 每 5 分钟排空持久 outbox。每日检查 synthetic 与 error budget；每周检查 outbox oldest age、D1 容量和 trace/log sampling；每次发布核对 deployment annotation；每季度演练一次 staging rollback 与凭据轮换。scheduled handler 必须显式记录完成/失败并保留可重试状态，不能只依赖返回 `Err`。
