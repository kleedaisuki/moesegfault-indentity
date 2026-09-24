/**
 * 同一部署环境中的三个受控服务源；未知主机沿用生产环境回退。
 * Controlled origins for one deployment environment; unknown hosts retain the production fallback.
 */
export interface FrontendOrigins {
  readonly identity: string;
  readonly login: string;
  readonly account: string;
}

const production: FrontendOrigins = {
  identity: "https://identity.moesegfault.dev",
  login: "https://login.moesegfault.dev",
  account: "https://account.moesegfault.dev",
};

const staging: FrontendOrigins = {
  identity: "https://identity-staging.moesegfault.dev",
  login: "https://login-staging.moesegfault.dev",
  account: "https://account-staging.moesegfault.dev",
};

const local: FrontendOrigins = {
  identity: "http://localhost:8787",
  login: "http://localhost:5173",
  account: "http://localhost:5174",
};

/**
 * 按 Login 或 Account 主机选择成套服务源，避免前端应用间映射漂移。
 * Selects a paired origin set by Login or Account hostname to prevent cross-app mapping drift.
 *
 * @example
 * ```ts
 * frontendOrigins("login-staging.moesegfault.dev").account;
 * // "https://account-staging.moesegfault.dev"
 * ```
 */
export function frontendOrigins(hostname: string): FrontendOrigins {
  if (hostname === "login-staging.moesegfault.dev" || hostname === "account-staging.moesegfault.dev") return staging;
  if (hostname === "localhost" || hostname === "127.0.0.1") return local;
  return production;
}
