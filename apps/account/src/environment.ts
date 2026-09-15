/** 根据账号站 hostname 选择对应 Identity authority。Maps the Account hostname to its Identity authority. */
export function resolveIdentityOrigin(location: Pick<Location, "hostname">, override?: string): string {
  if (override) return override;
  if (location.hostname === "account-staging.moesegfault.dev") return "https://identity-staging.moesegfault.dev";
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "http://localhost:8787";
  return "https://identity.moesegfault.dev";
}
