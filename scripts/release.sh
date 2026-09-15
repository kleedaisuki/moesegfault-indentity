#!/usr/bin/env bash
# Promote the exact tested bundle through one environment. / 将完全相同的已测试制品提升到指定环境。
set -euo pipefail

readonly TARGET="${1:-}"
readonly IDENTITY_CONFIG="wrangler.identity.jsonc"
readonly LOGIN_CONFIG="wrangler.login.jsonc"
readonly ACCOUNT_CONFIG="wrangler.account.jsonc"
readonly RELEASE_MESSAGE="${RELEASE_MESSAGE:-release ${GITHUB_SHA:-local}}"
readonly RELEASE_TAG="${GITHUB_SHA:-manual-$(date -u +%Y%m%dT%H%M%SZ)}-${TARGET}"

if [[ "$TARGET" != "staging" && "$TARGET" != "production" ]]; then
  printf 'usage: %s <staging|production>\n' "$0" >&2
  exit 2
fi

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
test -f crates/identity-worker/build/worker/shim.mjs
test -f apps/login/dist/index.html
test -f apps/account/dist/index.html

env_args() {
  printf '%s\n' --env
  if [[ "$TARGET" == "production" ]]; then
    printf '%s\n' production
  else
    printf '\n'
  fi
}

verify_runtime_secrets() {
  local secrets_json secret
  local -a args required=(REGISTRATION_PEPPER RECOVERY_CODE_PEPPER TRANSACTION_PEPPER TRANSACTION_STATE_KEY SESSION_PEPPER CSRF_PEPPER)
  mapfile -t args < <(env_args)
  if [[ "$(jq -r ".env.${TARGET}.vars.OAUTH_ENABLED // .vars.OAUTH_ENABLED" "$IDENTITY_CONFIG")" == "true" ]]; then
    required+=(AUTHORIZATION_CODE_PEPPER REFRESH_TOKEN_PEPPER PAIRWISE_SUBJECT_KEY OIDC_PRIVATE_KEY_PKCS8)
  fi
  secrets_json="$(npx --no-install wrangler secret list "${args[@]}" --config "$IDENTITY_CONFIG")"
  for secret in "${required[@]}"; do
    jq -e --arg name "$secret" 'any(.[]; .name == $name)' <<<"$secrets_json" >/dev/null || {
      printf 'release blocked: missing %s secret / 发布被阻止：%s 缺少密钥: %s\n' "$TARGET" "$TARGET" "$secret" >&2
      exit 1
    }
  done
}

deploy_unit() {
  local config="$1"
  local -a args
  mapfile -t args < <(env_args)
  # Deploy reconciles the reviewed Custom Domain on first release and creates a reversible version.
  # Deploy 会在首次发布时调和已评审的 Custom Domain，并创建可回滚版本。
  npx --no-install wrangler deploy --strict --tag "$RELEASE_TAG" --message "$RELEASE_MESSAGE" "${args[@]}" --config "$config"
}

verify_runtime_secrets

# Worker rollback cannot restore data; migrations must remain expand/migrate/contract compatible.
# Worker 回滚无法恢复数据；迁移必须保持扩展—迁移—收缩兼容性。
readonly DB_NAME="moesegfault-identity-${TARGET}"
declare -a d1_args=(--remote --config "$IDENTITY_CONFIG")
d1_args+=(--env)
if [[ "$TARGET" == "production" ]]; then
  d1_args+=(production)
else
  d1_args+=("")
fi
npx --no-install wrangler d1 migrations list "$DB_NAME" "${d1_args[@]}"
npx --no-install wrangler d1 migrations apply "$DB_NAME" "${d1_args[@]}"

# Authority first, then both independent user experiences. / 先发布身份权威，再发布两个独立用户界面。
deploy_unit "$IDENTITY_CONFIG"
deploy_unit "$LOGIN_CONFIG"
deploy_unit "$ACCOUNT_CONFIG"
scripts/smoke.sh "$TARGET"
