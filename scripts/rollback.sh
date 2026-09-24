#!/usr/bin/env bash
# Roll back code/assets only; persistent data is intentionally untouched. / 仅回滚代码与资产；持久数据保持不变。
set -euo pipefail
# shellcheck source=scripts/lib/wrangler-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/wrangler-env.sh"

if [[ $# -ne 4 ]]; then
  printf 'usage: %s <staging|production> <identity-version-id> <login-version-id> <account-version-id>\n' "$0" >&2
  exit 2
fi

readonly TARGET="$1"
readonly IDENTITY_VERSION="$2"
readonly LOGIN_VERSION="$3"
readonly ACCOUNT_VERSION="$4"
readonly REASON="${ROLLBACK_REASON:-operator-requested rollback}"
[[ "$TARGET" == "staging" || "$TARGET" == "production" ]] || exit 2
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

declare -a args=(--yes --message "$REASON")
mapfile -t env_args < <(wrangler_env_args "$TARGET")
args+=("${env_args[@]}")

# Restore both presentations before their authority. / 先恢复两个展示层，再恢复身份权威。
npx --no-install wrangler rollback "$ACCOUNT_VERSION" "${args[@]}" --config wrangler.account.jsonc
npx --no-install wrangler rollback "$LOGIN_VERSION" "${args[@]}" --config wrangler.login.jsonc
npx --no-install wrangler rollback "$IDENTITY_VERSION" "${args[@]}" --config wrangler.identity.jsonc
scripts/smoke.sh "$TARGET"
