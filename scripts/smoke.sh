#!/usr/bin/env bash
# Probe user-visible contracts after rollout. / 发布后探测用户可见契约。
set -euo pipefail

readonly TARGET="${1:-production}"
if [[ "$TARGET" != "staging" && "$TARGET" != "production" ]]; then
  printf 'usage: %s [staging|production]\n' "$0" >&2
  exit 2
fi

if [[ "$TARGET" == "staging" ]]; then
  readonly IDENTITY_URL="${IDENTITY_URL:-https://identity-staging.moesegfault.dev}"
  readonly LOGIN_URL="${LOGIN_URL:-https://login-staging.moesegfault.dev}"
  readonly ACCOUNT_URL="${ACCOUNT_URL:-https://account-staging.moesegfault.dev}"
else
  readonly IDENTITY_URL="${IDENTITY_URL:-https://identity.moesegfault.dev}"
  readonly LOGIN_URL="${LOGIN_URL:-https://login.moesegfault.dev}"
  readonly ACCOUNT_URL="${ACCOUNT_URL:-https://account.moesegfault.dev}"
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

retry_curl() {
  local output="$1"
  shift
  curl --fail --silent --show-error --location --retry 8 --retry-all-errors \
    --retry-delay 5 --connect-timeout 10 --max-time 30 --output "$output" "$@"
}

check_frontend() {
  local name="$1" url="$2"
  retry_curl "$tmp_dir/${name}.html" --dump-header "$tmp_dir/${name}.headers" "$url/"
  test -s "$tmp_dir/${name}.html"
  grep -Eiq '^content-type:[[:space:]]*text/html' "$tmp_dir/${name}.headers"
  grep -Eiq '^content-security-policy:' "$tmp_dir/${name}.headers"
  grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "$tmp_dir/${name}.headers"
  grep -Eiq '^referrer-policy:' "$tmp_dir/${name}.headers"
}

retry_curl "$tmp_dir/identity.json" "$IDENTITY_URL/healthz"
jq -e '.status == "ok" and .checks.d1 == "ok" and (.version | type == "string")' "$tmp_dir/identity.json" >/dev/null
retry_curl "$tmp_dir/oidc.json" "$IDENTITY_URL/.well-known/openid-configuration"
jq -e --arg issuer "$IDENTITY_URL" '.issuer == $issuer and (.authorization_endpoint | type == "string") and (.token_endpoint | type == "string") and (.jwks_uri | type == "string")' "$tmp_dir/oidc.json" >/dev/null
check_frontend login "$LOGIN_URL"
check_frontend account "$ACCOUNT_URL"

printf 'smoke checks passed / 冒烟检查通过: %s, %s, %s\n' "$IDENTITY_URL" "$LOGIN_URL" "$ACCOUNT_URL"
