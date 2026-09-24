import { frontendOrigins } from "@moesegfault/frontend-shared";

/** 根据账号站 hostname 选择对应 Identity authority。Maps the Account hostname to its Identity authority. */
export function resolveIdentityOrigin(location: Pick<Location, "hostname">, override?: string): string {
  return override || frontendOrigins(location.hostname).identity;
}

/** 将 Account 环境精确配对到 Login origin。Maps the Account environment to its exact paired Login origin. */
export function resolveLoginOrigin(location: Pick<Location, "hostname">): string {
  return frontendOrigins(location.hostname).login;
}

/** 返回受控的同环境 Account origin。Returns the controlled same-environment Account origin. */
export function resolveAccountOrigin(location: Pick<Location, "hostname">): string {
  return frontendOrigins(location.hostname).account;
}

/**
 * 生成同环境登录地址，并保留规范化后的 Account 深链接。
 * Builds a paired Login URL that preserves a normalized Account deep link.
 */
export function accountLoginUrl(location: Pick<Location, "hostname">, route: string): string {
  const url = new URL("/login", resolveLoginOrigin(location));
  url.searchParams.set("return_uri", `${resolveAccountOrigin(location)}${route}`);
  return url.href;
}

/** 生成同环境 Login 注册页地址。Builds the registration URL on the paired Login origin. */
export function accountRegistrationUrl(location: Pick<Location, "hostname">): string {
  return new URL("/register", resolveLoginOrigin(location)).href;
}
