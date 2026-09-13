#!/usr/bin/env bash
# Deploy tested artifacts in dependency order. / 按依赖顺序发布已验证制品。
set -euo pipefail

readonly IDENTITY_CONFIG="wrangler.identity.jsonc"
readonly LOGIN_CONFIG="wrangler.login.jsonc"
readonly RELEASE_MESSAGE="${RELEASE_MESSAGE:-release ${GITHUB_SHA:-local}}"
readonly RELEASE_TAG="${GITHUB_SHA:-manual-$(date -u +%Y%m%dT%H%M%SZ)}"

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

deploy_version() {
  local config="$1"

  # Code promotion must not rewrite DNS/routes. Trigger provisioning is a separate
  # operator operation; this also keeps the routine CI token least-privileged.
  # 代码提升不应重写 DNS/路由。触发器由运维单独配置，也让日常 CI 令牌保持最小权限。
  npx --no-install wrangler versions upload --strict \
    --tag "$RELEASE_TAG" --message "$RELEASE_MESSAGE" \
    --env production --config "$config"
  npx --no-install wrangler versions deploy \
    --version-tag "$RELEASE_TAG" --percentage 100 --yes \
    --message "$RELEASE_MESSAGE" --env production --config "$config"
}

# A build that can start is not necessarily configured to authenticate users. / 能启动的构建不等于已配置好认证。
verify_runtime_secrets

# D1 migrations must remain expand/contract compatible because a Worker rollback does not restore data. / Worker 回滚不恢复 D1，迁移必须向前兼容。
npx --no-install wrangler d1 migrations list moesegfault-identity-production \
  --remote --env production --config "$IDENTITY_CONFIG"
npx --no-install wrangler d1 migrations apply moesegfault-identity-production \
  --remote --env production --config "$IDENTITY_CONFIG"

# Upload and promote immutable versions without touching already-provisioned custom
# domains. / 上传并提升不可变版本，不触碰已配置的自定义域名。
deploy_version "$IDENTITY_CONFIG"
deploy_version "$LOGIN_CONFIG"

scripts/smoke.sh
