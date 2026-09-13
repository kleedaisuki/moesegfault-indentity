# ADR-0001：原子账号恢复 / Atomic Account Recovery

- 状态 / Status: Accepted
- 日期 / Date: 2026-09-13

## 背景 / Context

设计稿一处把主体生命周期限定为 `active`、`suspended`、`pending_deletion`、`deleted`，另一处又要求恢复代码消费后写入 `recovery_required`。这会混合生命周期与短暂流程状态，并产生一个真实的半完成窗口：恢复代码已消费、既有会话已撤销，但新 Passkey 尚未建立。若浏览器或短期恢复 Cookie 丢失，用户可能被永久锁死。

The design separately described four principal lifecycle states and a temporary `recovery_required` state. Persisting the latter mixes lifecycle with workflow progress and creates a half-completed window: recovery authority has been consumed while no replacement Passkey exists.

## 决策 / Decision

首期不持久化 `recovery_required`，也不签发 recovery-only session：

1. `POST /v1/recovery-transactions` 验证恢复代码、绑定浏览器并返回 WebAuthn creation options，但不消费代码，也不改变账号。
2. `POST .../{transaction_id}/completion` 先完成全部密码学验证，再用一个 D1 `batch()` 原子地：声明 transaction/code 的一次性消费、插入新 Authenticator、撤销所有旧 Authenticator、Identity Session、Authorization Code、Refresh Token family 和旧恢复代码、生成新恢复代码、建立正常 Identity Session，并追加 audit/outbox。
3. `principals.lifecycle_state` 继续只有四个生命周期值。被暂停的账号不得通过恢复隐式解封；只有 `active` 账号能完成用户自助恢复。
4. 任一消费竞争使用独立 consumption/use 表的主键 `INSERT` 决胜，而不是只依赖 `UPDATE ... WHERE consumed_at IS NULL` 的受影响行数。D1 `batch()` 中“更新零行”本身不会令后续语句失败。

The first release does not persist `recovery_required` and does not issue a recovery-only session. Begin is side-effect free; successful WebAuthn verification and every authority change commit in one D1 batch. Primary-key inserts into use/consumption tables are the atomic one-time claim.

## 后果 / Consequences

| 方面 / Dimension | 结果 / Consequence |
| --- | --- |
| 不变量 / Invariant | 提交前旧 Passkey 有效；提交后新 Passkey 有效，不存在“零有效 Passkey”的已提交状态。 |
| 重试 / Retry | 相同 idempotency key 可返回同一逻辑资源；恢复码明文不持久化，丢失的一次展示响应不可原样重放，客户端须以新 key 轮换一批。 |
| 并发 / Concurrency | 同一 code 或 transaction 的两个 completion 只有一个 use-row `INSERT` 成功。 |
| 会话 / Sessions | 成功恢复会撤销全部旧 Identity Session 与 OAuth refresh family，然后创建一个新 session。 |
| 可用性 / Availability | 仅“开始恢复”不会冻结受害者账号，也无需恢复会话清理器。 |

## 延后事项 / Deferrals

- Email、SMS、人工客服与管理员绕过恢复不进入首期。
- 自包含 JWT Access Token 最多仍可活到原 `exp`（上限五分钟）；首期不要求资源服务器在线查询撤销表。
- 物理删除与审计保留期限由后续数据治理 ADR 定义，不能通过直接删除 audit 行实现。

## 依据 / Evidence

- [Cloudflare D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) 将一批语句顺序执行，并在语句失败时回滚整批；因此消费声明必须产生真实约束失败。
- [Cloudflare D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) 默认强制外键，迁移只能延迟检查而不能依赖关闭检查。
- [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/) 定义 creation ceremony 及 RP/origin 验证边界。

