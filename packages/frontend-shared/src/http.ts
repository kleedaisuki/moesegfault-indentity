/**
 * 将配置的 API 地址约束为纯 HTTP(S) origin，不在此层决定环境配对。
 * Requires a configured API URL to be a plain HTTP(S) origin; environment pairing belongs to callers.
 *
 * @example
 * ```ts
 * apiOrigin("https://identity.moesegfault.dev"); // "https://identity.moesegfault.dev"
 * ```
 */
export function apiOrigin(value: string, errorMessage = "API origin must be a plain HTTP(S) origin"): string {
  const parsed = new URL(value);
  if (!/^https?:$/u.test(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError(errorMessage);
  }
  return parsed.origin;
}

/**
 * 只解析 JSON 问题详情，忽略代理 HTML 与损坏的响应正文。
 * Parses JSON Problem Details only, ignoring proxy HTML and malformed response bodies.
 * The caller owns its error type, status handling, and user-facing fallback text.
 */
export async function parseProblem<T>(response: Response): Promise<T | undefined> {
  if (!response.headers.get("content-type")?.includes("json")) return undefined;
  try {
    return await response.json() as T;
  } catch {
    return undefined;
  }
}
