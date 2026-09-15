/** 根据账号站 hostname 选择对应 Identity authority。Maps the Account hostname to its Identity authority. */
export function resolveIdentityOrigin(location: Pick<Location, "hostname">, override?: string): string {
  if (override) return override;
  if (location.hostname === "account-staging.moesegfault.dev") return "https://identity-staging.moesegfault.dev";
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "http://localhost:8787";
  return "https://identity.moesegfault.dev";
}

/** 将 Account 环境精确配对到 Login origin。Maps the Account environment to its exact paired Login origin. */
export function resolveLoginOrigin(location: Pick<Location, "hostname">): string {
  if (location.hostname === "account-staging.moesegfault.dev") return "https://login-staging.moesegfault.dev";
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "http://localhost:5173";
  return "https://login.moesegfault.dev";
}

/** 返回受控的同环境 Account origin。Returns the controlled same-environment Account origin. */
export function resolveAccountOrigin(location: Pick<Location, "hostname">): string {
  if (location.hostname === "account-staging.moesegfault.dev") return "https://account-staging.moesegfault.dev";
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "http://localhost:5174";
  return "https://account.moesegfault.dev";
}
