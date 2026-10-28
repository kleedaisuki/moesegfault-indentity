#!/usr/bin/env bash
# Promote the exact tested bundle through one environment. / 将完全相同的已测试制品提升到指定环境。
set -euo pipefail
# shellcheck source=scripts/lib/wrangler-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/wrangler-env.sh"

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
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID is required for platform domains}"
test -f crates/identity-worker/build/worker/shim.mjs
test -f apps/login/dist/index.html
test -f apps/account/dist/index.html
test -f dist/platform/notifications/index.js
test -f dist/platform/decisions/index.js

verify_runtime_secrets() {
  local secrets_json secret
  local -a args required=(
    REGISTRATION_PEPPER
    RECOVERY_CODE_PEPPER
    CONTACT_VERIFICATION_PEPPER
    EMAIL_OUTBOX_KEY_V1
    TRANSACTION_PEPPER
    TRANSACTION_STATE_KEY
    SESSION_PEPPER
    CSRF_PEPPER
  )
  mapfile -t args < <(wrangler_env_args "$TARGET")
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
  mapfile -t args < <(wrangler_env_args "$TARGET")
  # Domains are long-lived infrastructure reconciled by bootstrap-cloudflare.sh. Keeping them out
  # of application deploys lets the least-privilege CI token publish code without zone-route access.
  # 域名属于由 bootstrap-cloudflare.sh 调和的长期基础设施。将其与应用发布分离后，
  # 最小权限 CI token 无需 zone-route 权限即可发布代码。
  case "$config" in
    wrangler.notifications.jsonc) args+=(dist/platform/notifications/index.js --no-bundle --minify=false) ;;
    wrangler.decisions.jsonc) args+=(dist/platform/decisions/index.js --no-bundle --minify=false) ;;
  esac
  npx --no-install wrangler deploy --strict --tag "$RELEASE_TAG" --message "$RELEASE_MESSAGE" "${args[@]}" --config "$config"
}

ensure_outbox_key() {
  local config="$1" secrets_json key
  local -a args
  mapfile -t args < <(wrangler_env_args "$TARGET")
  secrets_json="$(npx --no-install wrangler secret list "${args[@]}" --config "$config")"
  if ! jq -e 'any(.[]; .name == "OUTBOX_KEY")' <<<"$secrets_json" >/dev/null; then
    # Only create a missing encryption key. Rotation must retain keys for outstanding messages.
    key="$(node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('base64url'))")"
    printf '%s' "$key" | npx --no-install wrangler secret put OUTBOX_KEY "${args[@]}" --config "$config"
    unset key
  fi
}

verify_runtime_secrets
node scripts/provision-platform.mjs "$TARGET"
mapfile -t platform_env_args < <(wrangler_env_args "$TARGET")
if [[ "$TARGET" == "staging" ]]; then
  fixture_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/moesegfault-platform-journey-staging")"
  case "$fixture_status" in
    200) printf 'staging callback fixture already exists; preserving its full journey bindings\n' ;;
    404) deploy_unit wrangler.platform-journey-bootstrap.jsonc ;;
    *) printf 'cannot inspect staging callback fixture: Cloudflare HTTP %s\n' "$fixture_status" >&2; exit 1 ;;
  esac
fi
for unit in notifications decisions; do
  npx --no-install wrangler d1 migrations apply "moesegfault-${unit}-${TARGET}" --remote "${platform_env_args[@]}" --config "wrangler.${unit}.jsonc"
  deploy_unit "wrangler.${unit}.jsonc"
  ensure_outbox_key "wrangler.${unit}.jsonc"
done
node scripts/reconcile-platform-domains.mjs "$TARGET"

# Worker rollback cannot restore data; migrations must remain expand/migrate/contract compatible.
# Worker 回滚无法恢复数据；迁移必须保持扩展—迁移—收缩兼容性。
readonly DB_NAME="moesegfault-identity-${TARGET}"
# Materialize only this issuer's reviewed overlay; names of already-applied common migrations stay unchanged.
# 仅物化当前发行方已评审的专属迁移；已应用的公共迁移文件名保持不变。
node scripts/prepare-migrations.mjs "$TARGET"
declare -a d1_args=(--remote --config "$IDENTITY_CONFIG")
mapfile -t env_args < <(wrangler_env_args "$TARGET")
d1_args+=("${env_args[@]}")
npx --no-install wrangler d1 migrations list "$DB_NAME" "${d1_args[@]}"
npx --no-install wrangler d1 migrations apply "$DB_NAME" "${d1_args[@]}"

# Authority first, then both independent user experiences. / 先发布身份权威，再发布两个独立用户界面。
deploy_unit "$IDENTITY_CONFIG"
deploy_unit "$LOGIN_CONFIG"
deploy_unit "$ACCOUNT_CONFIG"
scripts/smoke.sh "$TARGET"
