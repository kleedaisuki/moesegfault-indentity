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

request_status() {
  local output="$1"
  shift
  curl --silent --show-error --retry 8 --retry-all-errors --retry-delay 5 \
    --connect-timeout 10 --max-time 30 --output "$output" --write-out '%{http_code}' "$@"
}

header_has_line() {
  local headers="$1" expected="$2"
  tr -d '\r' <"$headers" | grep -Fxiq "$expected"
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

# Credentialed CORS must survive both preflight and unauthenticated error responses. The latter
# catches regressions where only successful handlers add CORS headers and browsers hide the real
# Problem Details response. / 凭据式 CORS 必须覆盖预检和未认证错误响应；后者可发现仅成功
# handler 添加 CORS 头、导致浏览器吞掉真实 Problem Details 的回归。
me_status="$(request_status "$tmp_dir/me.json" --dump-header "$tmp_dir/me.headers" \
  --header "Origin: $ACCOUNT_URL" "$IDENTITY_URL/v1/me")"
test "$me_status" = "401"
jq -e '.status == 401 and .error_code == "authentication_failed"' "$tmp_dir/me.json" >/dev/null
header_has_line "$tmp_dir/me.headers" "access-control-allow-origin: $ACCOUNT_URL"
grep -Eiq '^access-control-allow-credentials:[[:space:]]*true' "$tmp_dir/me.headers"
grep -Eiq '^vary:.*(^|[[:space:],])Origin([[:space:],]|$)' "$tmp_dir/me.headers"

preflight_status="$(request_status "$tmp_dir/preflight.body" \
  --dump-header "$tmp_dir/preflight.headers" --request OPTIONS \
  --header "Origin: $ACCOUNT_URL" --header 'Access-Control-Request-Method: GET' \
  "$IDENTITY_URL/v1/me")"
test "$preflight_status" = "204"
header_has_line "$tmp_dir/preflight.headers" "access-control-allow-origin: $ACCOUNT_URL"
grep -Eiq '^access-control-allow-credentials:[[:space:]]*true' "$tmp_dir/preflight.headers"
grep -Eiq '^access-control-allow-methods:.*(^|[[:space:],])GET([[:space:],]|$)' "$tmp_dir/preflight.headers"

printf 'smoke checks passed / 冒烟检查通过: %s, %s, %s\n' "$IDENTITY_URL" "$LOGIN_URL" "$ACCOUNT_URL"
