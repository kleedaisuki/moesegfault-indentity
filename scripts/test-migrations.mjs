/**
 * Exercise populated D1 migrations instead of only the empty-database happy path.
 * 对含真实依赖行的 D1 执行迁移，避免只验证空数据库而漏掉外键重建错误。
 */
import { rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const stateDir = ".temp/migration-regression";
const database = "moesegfault-identity-staging";
const config = "wrangler.identity.jsonc";
const wrangler = "node_modules/wrangler/bin/wrangler.js";

// The target is a fixed repository-local directory, never caller-controlled.
// 目标是固定的仓库内目录，绝不使用调用方输入拼接删除路径。
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

for (const file of [
  "migrations/0001_identity_foundation.sql",
  "migrations/tests/0002_populated_seed.sql",
  "migrations/0002_account_foundation.sql",
  "migrations/tests/0002_populated_assert.sql",
  "migrations/0003_open_registration.sql",
]) {
  const result = spawnSync(process.execPath, [
    wrangler, "d1", "execute", database,
    "--local", `--persist-to=${stateDir}`, `--config=${config}`, `--file=${file}`,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
