/**
 * 根据受控 Login hostname 选择对应的 Identity authority。
 * Selects the matching Identity authority from a controlled Login hostname.
 *
 * 构建时 override 只用于显式 preview；正常 staging/production 使用固定映射，
 * 避免同一静态制品在 staging 悄悄连接 production。
 * A build-time override is only for explicit previews; normal staging and production
 * use fixed mappings so the same static artifact never silently crosses environments.
 */
export function resolveIdentityOrigin(location: Pick<Location, "hostname">, override?: string): string {
  if (override) return override;
  if (location.hostname === "login-staging.moesegfault.dev") {
    return "https://identity-staging.moesegfault.dev";
  }
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "http://localhost:8787";
  }
  return "https://identity.moesegfault.dev";
}

/** 从登录环境映射到同环境账号中心，禁止 staging 跨到 production。Maps login to the same-environment Account origin. */
export function resolveAccountOrigin(location: Pick<Location, "hostname">): string {
  if (location.hostname === "login-staging.moesegfault.dev") return "https://account-staging.moesegfault.dev";
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "http://localhost:5174";
  return "https://account.moesegfault.dev";
}

const accountReturnPaths = new Set(["/", "/profile", "/security", "/sessions", "/apps"]);

/**
 * 验证 Account 回跳地址是当前环境的已知页面，且不携带用户信息、查询或片段。
 * Validates that an Account return URI is an exact known page in the paired environment,
 * without user-info, query, or fragment components.
 */
export function validateAccountReturnUri(location: Pick<Location, "hostname" | "href">): string | undefined {
  const requested = new URL(location.href).searchParams.get("return_uri");
  if (!requested) return undefined;
  try {
    const parsed = new URL(requested);
    if (parsed.origin !== resolveAccountOrigin(location) || parsed.username || parsed.password || parsed.search || parsed.hash || !accountReturnPaths.has(parsed.pathname)) return undefined;
    return parsed.href;
  } catch { return undefined; }
}

/** 为 Account 链接提供经验证的回跳地址，无效时回到配对的 Account 首页。Returns a validated Account link, falling back to the paired Account home. */
export function resolveAccountReturnUri(location: Pick<Location, "hostname" | "href">): string {
  return validateAccountReturnUri(location) ?? resolveAccountOrigin(location);
}
