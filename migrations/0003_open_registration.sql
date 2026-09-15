-- Public registration baseline / 公开注册基线
-- Registration no longer depends on an invitation capability. Keep the policy row and
-- revisioned state machine so operators can deliberately change modes without code changes.
-- 注册不再依赖邀请能力；保留带版本的策略状态机，使运维可显式切换模式而无需修改代码。

UPDATE registration_policy
SET mode = 'open',
    revision = revision + 1,
    updated_at = unixepoch()
WHERE policy_id = 1;
