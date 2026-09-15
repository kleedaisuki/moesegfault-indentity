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

/** 只接受与当前 Login 环境配对的 Account origin，路径可由 Account 指定。Accepts return paths only on the paired Account origin. */
export function resolveAccountReturnUri(location: Pick<Location, "hostname" | "href">): string {
  const accountOrigin = resolveAccountOrigin(location);
  const requested = new URL(location.href).searchParams.get("return_uri");
  if (!requested) return accountOrigin;
  try { const parsed = new URL(requested); return parsed.origin === accountOrigin ? parsed.href : accountOrigin; }
  catch { return accountOrigin; }
}
