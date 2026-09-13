#!/usr/bin/env bash
# Probe the two public deployment units after a rollout. / 发布后检查两个独立公网单元。
set -euo pipefail

readonly IDENTITY_URL="${IDENTITY_URL:-https://identity.moesegfault.dev}"
readonly LOGIN_URL="${LOGIN_URL:-https://login.moesegfault.dev}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

retry_curl() {
  local output="$1"
  shift
  curl --fail --silent --show-error --location \
    --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 10 --max-time 30 \
    --output "$output" "$@"
}

retry_curl "$tmp_dir/identity.json" "$IDENTITY_URL/healthz"
jq -e '.status == "ok" and .checks.d1 == "ok" and (.version | type == "string")' "$tmp_dir/identity.json" >/dev/null

retry_curl "$tmp_dir/login.html" --dump-header "$tmp_dir/login.headers" "$LOGIN_URL/"
grep -Eiq '^content-security-policy:' "$tmp_dir/login.headers"
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "$tmp_dir/login.headers"
grep -Eiq '^referrer-policy:[[:space:]]*no-referrer' "$tmp_dir/login.headers"

printf 'smoke checks passed / 冒烟检查通过: %s, %s\n' "$IDENTITY_URL" "$LOGIN_URL"
