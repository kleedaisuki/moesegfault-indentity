import { ACCOUNT_ROUTES, frontendOrigins } from "@moesegfault/frontend-shared";

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
  return override || frontendOrigins(location.hostname).identity;
}

/** 从登录环境映射到同环境账号中心，禁止 staging 跨到 production。Maps login to the same-environment Account origin. */
export function resolveAccountOrigin(location: Pick<Location, "hostname">): string {
  return frontendOrigins(location.hostname).account;
}

const accountReturnPaths: ReadonlySet<string> = new Set(ACCOUNT_ROUTES);

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

/** Build auth links carrying a public device code or a validated paired-Account destination. */
export function authRouteHref(route: "/login" | "/register" | "/recovery" | "/passkey/enroll", location?: Pick<Location, "hostname" | "href">): string {
  const code = location && deviceUserCode(location);
  if (code) return `${route}?${new URLSearchParams({ device_user_code: code })}`;
  const returnUri = location && validateAccountReturnUri(location);
  return returnUri ? `${route}?${new URLSearchParams({ return_uri: returnUri })}` : route;
}

/** A public device user code preserves intent across sign-in, registration and recovery. */
export function deviceUserCode(location: Pick<Location, "href">): string | undefined {
  const url = new URL(location.href);
  return (url.pathname.replace(/\/$/u, "") === "/device" ? url.searchParams.get("user_code") : url.searchParams.get("device_user_code"))?.trim() || undefined;
}

/** Always returns to this Login origin; device codes never supply a redirect destination. */
export function deviceContinuation(location: Pick<Location, "href">): string | undefined {
  const code = deviceUserCode(location);
  return code ? new URL(`/device?${new URLSearchParams({ user_code: code })}`, location.href).href : undefined;
}
