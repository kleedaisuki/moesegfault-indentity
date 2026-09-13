#!/usr/bin/env bash
# Roll back Worker code/assets only; D1 and R2 are intentionally untouched. / 仅回滚 Worker 代码与资产，不改 D1/R2。
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'usage: %s <identity-version-id> <login-version-id>\n' "$0" >&2
  exit 2
fi

readonly IDENTITY_VERSION="$1"
readonly LOGIN_VERSION="$2"
readonly REASON="${ROLLBACK_REASON:-operator-requested rollback}"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

# Restore the presentation contract first, then its authority. / 先恢复展示契约，再恢复身份权威。
npx --no-install wrangler rollback "$LOGIN_VERSION" --yes --env production \
  --config wrangler.login.jsonc --message "$REASON"
npx --no-install wrangler rollback "$IDENTITY_VERSION" --yes --env production \
  --config wrangler.identity.jsonc --message "$REASON"

scripts/smoke.sh
