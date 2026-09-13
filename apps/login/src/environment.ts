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
