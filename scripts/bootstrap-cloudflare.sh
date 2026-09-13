#!/usr/bin/env bash
# Provision or verify long-lived Cloudflare data resources. / 创建或验证 Cloudflare 长期数据资源。
set -euo pipefail

readonly STAGING_DB="moesegfault-identity-staging"
readonly STAGING_DB_ID="c4042bd4-bb4a-4cf7-aa7f-04cf1a5d6ad9"
readonly PRODUCTION_DB="moesegfault-identity-production"
readonly PRODUCTION_DB_ID="b3f4a7dd-4415-417d-a1eb-47c36a47ad24"
readonly STAGING_BUCKET="moesegfault-identity-audit-staging"
readonly PRODUCTION_BUCKET="moesegfault-identity-audit-production"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command / 缺少必需命令: %s\n' "$1" >&2
    exit 1
  }
}

ensure_d1() {
  local name="$1"
  local expected_id="$2"
  local databases actual_id

  databases="$(npx --no-install wrangler d1 list --json)"
  actual_id="$(jq -r --arg name "$name" '.[] | select(.name == $name) | .uuid' <<<"$databases")"
  if [[ -z "$actual_id" ]]; then
    # A newly created database receives a new UUID, so silently creating it can never satisfy
    # the reviewed binding below. Create it deliberately, then commit its ID through review.
    # 新数据库会获得新 UUID；静默创建不可能满足下方已评审绑定。请显式创建并评审提交新 ID。
    printf 'missing pinned D1 / 缺少已固定 D1: %s; run: wrangler d1 create %s; then review and update the pinned ID\n' \
      "$name" "$name" >&2
    exit 1
  fi

  if [[ "$actual_id" != "$expected_id" ]]; then
    printf '%s has ID %s, but config pins %s. Update config through review; it is not rewritten in CI.\n' \
      "$name" "$actual_id" "$expected_id" >&2
    exit 1
  fi
  printf 'verified D1 / D1 已验证: %s (%s)\n' "$name" "$actual_id"
}

ensure_bucket() {
  local name="$1"
  if ! npx --no-install wrangler r2 bucket info "$name" >/dev/null 2>&1; then
    # R2 buckets are private unless public access is explicitly enabled. / R2 存储桶默认私有。
    npx --no-install wrangler r2 bucket create "$name"
  fi
  npx --no-install wrangler r2 bucket info "$name" >/dev/null
  printf 'verified R2 bucket (bootstrap never enables public access) / R2 存储桶已验证（引导流程不开启公网访问）: %s\n' "$name"
}

verify_runtime_secrets() {
  local secrets_json secret
  local -a required=(
    REGISTRATION_PEPPER
    RECOVERY_CODE_PEPPER
    TRANSACTION_PEPPER
    TRANSACTION_STATE_KEY
    SESSION_PEPPER
    CSRF_PEPPER
  )
  if [[ "$(jq -r '.env.production.vars.OAUTH_ENABLED' wrangler.identity.jsonc)" == "true" ]]; then
    required+=(
      AUTHORIZATION_CODE_PEPPER
      REFRESH_TOKEN_PEPPER
      PAIRWISE_SUBJECT_KEY
      OIDC_PRIVATE_KEY_PKCS8
    )
  fi

  if ! secrets_json="$(npx --no-install wrangler secret list --env production --config wrangler.identity.jsonc 2>/dev/null)"; then
    printf 'identity Worker is not deployed yet; set runtime secrets immediately after its initial deployment / Identity Worker 尚未发布，首次发布后必须立即设置运行时密钥\n'
    return
  fi

  for secret in "${required[@]}"; do
    jq -e --arg name "$secret" 'any(.[]; .name == $name)' <<<"$secrets_json" >/dev/null || {
      printf 'missing production Worker secret / 缺少生产 Worker 密钥: %s\n' "$secret" >&2
      exit 1
    }
  done
  printf 'verified production Worker secret names / 生产 Worker 密钥名称已验证\n'
}

require_command jq
require_command npx
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

ensure_d1 "$STAGING_DB" "$STAGING_DB_ID"
ensure_d1 "$PRODUCTION_DB" "$PRODUCTION_DB_ID"
ensure_bucket "$STAGING_BUCKET"
ensure_bucket "$PRODUCTION_BUCKET"
verify_runtime_secrets

# Custom Domains are declarative in wrangler.*.jsonc; do not mutate DNS here. / 自定义域名由 Wrangler 声明，此处不改 DNS。
printf 'bootstrap complete; Custom Domains will reconcile during deploy / 引导完成，自定义域名将在发布时调和\n'
