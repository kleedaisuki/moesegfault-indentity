#!/usr/bin/env bash
# Keep Wrangler's explicit staging/production environment selection in one place.
# 将 Wrangler 对 staging/production 的显式环境选择集中在一处。

# Print one argument per line for mapfile; an empty staging value is intentional.
# 每行输出一个参数供 mapfile 读取；staging 的空值是有意的。
wrangler_env_args() {
  case "$1" in
    staging) printf '%s\n' --env '' ;;
    production) printf '%s\n' --env production ;;
    *) printf 'unsupported Wrangler environment / 不支持的 Wrangler 环境: %s\n' "$1" >&2; return 2 ;;
  esac
}
