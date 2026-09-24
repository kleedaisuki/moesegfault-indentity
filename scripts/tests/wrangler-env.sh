#!/usr/bin/env bash
# Verify the argument contract used by release, rollback, and bootstrap.
# 验证发布、回滚和引导脚本共用的参数契约。
set -euo pipefail
# shellcheck source=scripts/lib/wrangler-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/wrangler-env.sh"

mapfile -t staging < <(wrangler_env_args staging)
[[ ${#staging[@]} -eq 2 && ${staging[0]} == --env && -z ${staging[1]} ]]

mapfile -t production < <(wrangler_env_args production)
[[ ${#production[@]} -eq 2 && ${production[0]} == --env && ${production[1]} == production ]]

if wrangler_env_args invalid >/dev/null 2>&1; then
  printf 'invalid Wrangler environment unexpectedly accepted / 无效环境意外通过\n' >&2
  exit 1
fi
