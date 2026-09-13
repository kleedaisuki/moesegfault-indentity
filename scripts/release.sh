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
