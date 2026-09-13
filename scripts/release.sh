#!/usr/bin/env bash
# Deploy tested artifacts in dependency order. / 按依赖顺序发布已验证制品。
set -euo pipefail

readonly IDENTITY_CONFIG="wrangler.identity.jsonc"
readonly LOGIN_CONFIG="wrangler.login.jsonc"
readonly RELEASE_MESSAGE="${RELEASE_MESSAGE:-release ${GITHUB_SHA:-local}}"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
test -f crates/identity-worker/build/worker/shim.mjs
test -f apps/login/dist/index.html

verify_runtime_secrets() {
  local secrets_json secret
  local -a required=(
    REGISTRATION_PEPPER RECOVERY_CODE_PEPPER TRANSACTION_PEPPER
    TRANSACTION_STATE_KEY SESSION_PEPPER CSRF_PEPPER
  )
  if [[ "$(jq -r '.env.production.vars.OAUTH_ENABLED' "$IDENTITY_CONFIG")" == "true" ]]; then
    required+=(AUTHORIZATION_CODE_PEPPER REFRESH_TOKEN_PEPPER PAIRWISE_SUBJECT_KEY OIDC_PRIVATE_KEY_PKCS8)
  fi
  secrets_json="$(npx --no-install wrangler secret list --env production --config "$IDENTITY_CONFIG")"
  for secret in "${required[@]}"; do
    jq -e --arg name "$secret" 'any(.[]; .name == $name)' <<<"$secrets_json" >/dev/null || {
      printf 'release blocked: missing production Worker secret / 发布被阻止：缺少生产 Worker 密钥: %s\n' "$secret" >&2
      exit 1
    }
  done
}

# A build that can start is not necessarily configured to authenticate users. / 能启动的构建不等于已配置好认证。
verify_runtime_secrets

# D1 migrations must remain expand/contract compatible because a Worker rollback does not restore data. / Worker 回滚不恢复 D1，迁移必须向前兼容。
npx --no-install wrangler d1 migrations list moesegfault-identity-production \
  --remote --env production --config "$IDENTITY_CONFIG"
npx --no-install wrangler d1 migrations apply moesegfault-identity-production \
  --remote --env production --config "$IDENTITY_CONFIG"

# Strict deployment rejects configuration drift instead of silently accepting it. / 严格发布拒绝静默配置漂移。
npx --no-install wrangler deploy --strict --env production --config "$IDENTITY_CONFIG" \
  --message "$RELEASE_MESSAGE"
npx --no-install wrangler deploy --strict --env production --config "$LOGIN_CONFIG" \
  --message "$RELEASE_MESSAGE"

scripts/smoke.sh
