#!/usr/bin/env bash
# Provision or verify long-lived Cloudflare data resources. / 创建或验证 Cloudflare 长期数据资源。
set -euo pipefail

readonly STAGING_DB="moesegfault-identity-staging"
readonly STAGING_DB_ID="c4042bd4-bb4a-4cf7-aa7f-04cf1a5d6ad9"
readonly PRODUCTION_DB="moesegfault-identity-production"
readonly PRODUCTION_DB_ID="b3f4a7dd-4415-417d-a1eb-47c36a47ad24"
readonly STAGING_BUCKET="moesegfault-identity-audit-staging"
readonly PRODUCTION_BUCKET="moesegfault-identity-audit-production"
readonly STAGING_AVATAR_BUCKET="moesegfault-avatars-staging"
readonly PRODUCTION_AVATAR_BUCKET="moesegfault-avatars-production"
readonly STAGING_AVATAR_DOMAIN="avatars-staging.moesegfault.dev"
readonly PRODUCTION_AVATAR_DOMAIN="avatars.moesegfault.dev"
readonly ZONE_NAME="moesegfault.dev"
readonly TARGET="${1:-}"

if [[ "$TARGET" != "staging" && "$TARGET" != "production" ]]; then
  printf 'usage: %s <staging|production>\n' "$0" >&2
  exit 2
fi

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

ensure_bucket_domain() {
  local bucket="$1"
  local domain="$2"
  if ! npx --no-install wrangler r2 bucket domain get "$bucket" --domain "$domain" >/dev/null 2>&1; then
    # R2 custom domains publish only immutable avatar bytes; the AVATARS Worker binding remains
    # private for writes/deletes. / R2 自定义域名仅发布不可变头像；AVATARS Worker binding 的写入/删除仍为私有。
    npx --no-install wrangler r2 bucket domain add "$bucket" \
      --domain "$domain" --zone-id "$CLOUDFLARE_ZONE_ID" --min-tls 1.2 --force
  fi
  npx --no-install wrangler r2 bucket domain get "$bucket" --domain "$domain" >/dev/null
  printf 'verified avatar custom domain / 头像自定义域名已验证: %s -> %s\n' "$domain" "$bucket"
}

ensure_worker_domain() {
  local service="$1"
  local hostname="$2"
  local response

  # The account-level Custom Domains API needs Workers Scripts Write, not the broader zone-level
  # Workers Routes permission. This keeps application delivery and DNS lifecycle independently
  # operable. / account 级 Custom Domains API 仅需 Workers Scripts Write，无需范围更大的
  # zone Workers Routes 权限，从而让应用发布与域名生命周期可以独立运维。
  response="$(curl --fail-with-body --silent --show-error \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains" \
    --request PUT \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header 'Content-Type: application/json' \
    --data "$(jq -cn \
      --arg hostname "$hostname" \
      --arg service "$service" \
      --arg zone_id "$CLOUDFLARE_ZONE_ID" \
      --arg zone_name "$ZONE_NAME" \
      '{hostname: $hostname, service: $service, zone_id: $zone_id, zone_name: $zone_name}')")"
  jq -e '.success == true' <<<"$response" >/dev/null
  printf 'verified Worker custom domain / Worker 自定义域名已验证: %s -> %s\n' "$hostname" "$service"
}

verify_runtime_secrets() {
  local target="$1"
  local secrets_json secret
  local -a env_args=()
  local -a required=(
    REGISTRATION_PEPPER
    RECOVERY_CODE_PEPPER
    TRANSACTION_PEPPER
    TRANSACTION_STATE_KEY
    SESSION_PEPPER
    CSRF_PEPPER
  )
  # An empty Wrangler environment explicitly selects the top-level staging configuration.
  # 空 Wrangler 环境会明确选择顶层 staging 配置，而不是含糊地省略目标。
  env_args=(--env "")
  [[ "$target" == "production" ]] && env_args=(--env production)
  if [[ "$(jq -r ".env.${target}.vars.OAUTH_ENABLED // .vars.OAUTH_ENABLED" wrangler.identity.jsonc)" == "true" ]]; then
    required+=(
      AUTHORIZATION_CODE_PEPPER
      REFRESH_TOKEN_PEPPER
      PAIRWISE_SUBJECT_KEY
      OIDC_PRIVATE_KEY_PKCS8
    )
  fi

  if ! secrets_json="$(npx --no-install wrangler secret list "${env_args[@]}" --config wrangler.identity.jsonc 2>/dev/null)"; then
    printf '%s Identity Worker is not deployed yet; set runtime secrets before release / %s Identity Worker 尚未发布，请在发布前设置密钥\n' "$target" "$target"
    return
  fi

  for secret in "${required[@]}"; do
    jq -e --arg name "$secret" 'any(.[]; .name == $name)' <<<"$secrets_json" >/dev/null || {
      printf 'missing %s Worker secret / 缺少 %s Worker 密钥: %s\n' "$target" "$target" "$secret" >&2
      exit 1
    }
  done
  printf 'verified %s Worker secret names / %s Worker 密钥名称已验证\n' "$target" "$target"
}

require_command jq
require_command npx
require_command curl
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID is required for avatar custom domains}"

ensure_d1 "$STAGING_DB" "$STAGING_DB_ID"
ensure_d1 "$PRODUCTION_DB" "$PRODUCTION_DB_ID"
ensure_bucket "$STAGING_BUCKET"
ensure_bucket "$PRODUCTION_BUCKET"
ensure_bucket "$STAGING_AVATAR_BUCKET"
ensure_bucket "$PRODUCTION_AVATAR_BUCKET"
ensure_bucket_domain "$STAGING_AVATAR_BUCKET" "$STAGING_AVATAR_DOMAIN"
ensure_bucket_domain "$PRODUCTION_AVATAR_BUCKET" "$PRODUCTION_AVATAR_DOMAIN"
ensure_worker_domain "moesegfault-identity-staging" "identity-staging.moesegfault.dev"
ensure_worker_domain "moesegfault-login-staging" "login-staging.moesegfault.dev"
ensure_worker_domain "moesegfault-account-staging" "account-staging.moesegfault.dev"
ensure_worker_domain "moesegfault-identity" "identity.moesegfault.dev"
ensure_worker_domain "moesegfault-login" "login.moesegfault.dev"
ensure_worker_domain "moesegfault-account" "account.moesegfault.dev"
verify_runtime_secrets "$TARGET"

# Avatar object names are immutable UUIDs. Replaced/deleted objects are removed best-effort by
# the Worker; their retained `avatar_assets(state='deleted')` rows are the retry inventory for an
# operational reaper. Do not install a bucket-wide expiry rule: it would also delete current
# avatars. / 头像对象名为不可变 UUID；Worker 会尽力清除被替换/删除对象，保留的 deleted 行是
# 运维 reaper 的重试清单。不要配置全桶过期规则，否则当前头像也会被删除。

printf 'bootstrap complete; data resources and custom domains are reconciled / 引导完成：数据资源与自定义域名均已调和\n'
