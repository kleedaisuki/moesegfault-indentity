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
  --header "Origin: $ACCOUNT_URL" --header 'Access-Control-Request-Method: PUT' \
  --header 'Access-Control-Request-Headers: content-type, x-moesegfault-csrf, idempotency-key' \
  "$IDENTITY_URL/v1/me/password")"
test "$preflight_status" = "204"
header_has_line "$tmp_dir/preflight.headers" "access-control-allow-origin: $ACCOUNT_URL"
grep -Eiq '^access-control-allow-credentials:[[:space:]]*true' "$tmp_dir/preflight.headers"
grep -Eiq '^access-control-allow-methods:.*(^|[[:space:],])PUT([[:space:],]|$)' "$tmp_dir/preflight.headers"
for allowed_header in content-type x-moesegfault-csrf idempotency-key; do
  grep -Eiq "^access-control-allow-headers:.*(^|[[:space:],])${allowed_header}([[:space:],]|$)" "$tmp_dir/preflight.headers"
done

# The idempotency pre-claim boundary must use the same paired-origin policy as CORS and handlers.
# With a valid Account-origin browser envelope but no session cookie, this command must reach
# authentication (401), never be rejected as an origin error (403). / 幂等预声明边界必须与 CORS
# 和 handler 共用成对 Origin 策略；合法 Account Origin 缺少会话时应到达认证层，而不是被 403。
mutation_status="$(request_status "$tmp_dir/account-mutation.json" \
  --dump-header "$tmp_dir/account-mutation.headers" --request POST \
  --header "Origin: $ACCOUNT_URL" --header 'Sec-Fetch-Site: same-site' \
  --header 'Sec-Fetch-Mode: cors' --header 'Content-Type: application/json' \
  --header 'X-moeSegFault-CSRF: smoke-test' \
  --header 'Idempotency-Key: account-origin-smoke-test' --data '{}' \
  "$IDENTITY_URL/v1/me/contacts/018f0000-0000-7000-8000-000000000000/verification-transactions")"
test "$mutation_status" = "401"
jq -e '.status == 401 and .error_code == "authentication_failed"' "$tmp_dir/account-mutation.json" >/dev/null
header_has_line "$tmp_dir/account-mutation.headers" "access-control-allow-origin: $ACCOUNT_URL"

# Binding revocation has its own bodyless-mutation guard behind the generic idempotency boundary.
# Exercise that second boundary independently so it cannot drift back to a Login-only policy.
# Binding 撤销在通用幂等边界之后还有独立的无请求体检查；单独探测该边界，防止再次退化为仅允许 Login。
binding_status="$(request_status "$tmp_dir/account-binding-delete.json" \
  --dump-header "$tmp_dir/account-binding-delete.headers" --request DELETE \
  --header "Origin: $ACCOUNT_URL" --header 'Sec-Fetch-Site: same-site' \
  --header 'Sec-Fetch-Mode: cors' --header 'X-moeSegFault-CSRF: smoke-test' \
  --header 'Idempotency-Key: account-binding-origin-smoke' \
  "$IDENTITY_URL/v1/principals/self/bindings/018f0000-0000-7000-8000-000000000000")"
test "$binding_status" = "401"
jq -e '.status == 401 and .error_code == "reauthentication_required"' "$tmp_dir/account-binding-delete.json" >/dev/null
header_has_line "$tmp_dir/account-binding-delete.headers" "access-control-allow-origin: $ACCOUNT_URL"

# Rejected origins must not receive a fallback Login ACAO from inner idempotency responses.
# 被拒绝的 Origin 不得从幂等内层错误响应获得兜底的 Login ACAO。
rejected_origin_status="$(request_status "$tmp_dir/rejected-origin.json" \
  --dump-header "$tmp_dir/rejected-origin.headers" --request POST \
  --header 'Origin: https://account.moesegfault.dev.evil.example' \
  --header 'Sec-Fetch-Site: cross-site' --header 'Sec-Fetch-Mode: cors' \
  --header 'Content-Type: application/json' --header 'X-moeSegFault-CSRF: smoke-test' \
  --header 'Idempotency-Key: rejected-origin-smoke-test' --data '{}' \
  "$IDENTITY_URL/v1/me/contacts/018f0000-0000-7000-8000-000000000000/verification-transactions")"
test "$rejected_origin_status" = "403"
jq -e '.status == 403 and .error_code == "invalid_request"' "$tmp_dir/rejected-origin.json" >/dev/null
! grep -Eiq '^access-control-allow-origin:' "$tmp_dir/rejected-origin.headers"

printf 'smoke checks passed / 冒烟检查通过: %s, %s, %s\n' "$IDENTITY_URL" "$LOGIN_URL" "$ACCOUNT_URL"
