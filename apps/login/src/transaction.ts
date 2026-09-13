/** 页面生命周期内唯一保存的 OIDC/认证事务句柄。Only page-lifetime storage for the OIDC/auth transaction handle. */
let transactionHandle: string | undefined;

/**
 * 在任何网络请求前读取 `tx` 并立即清理 URL 和 fragment。
 * Reads `tx` and immediately scrubs the URL and fragment before any network request.
 */
export function captureAndScrubTransaction(location: Location, history: History): string | undefined {
  const url = new URL(location.href);
  const value = url.searchParams.get("tx")?.trim() || undefined;
  url.searchParams.delete("tx");
  url.hash = "";
  const clean = `${url.pathname}${url.search}`;
  if (`${location.pathname}${location.search}${location.hash}` !== clean) {
    history.replaceState(history.state, "", clean);
  }
  transactionHandle = value;
  return value;
}

/** 返回只存在于当前 JavaScript Realm 的事务句柄。Returns the transaction handle held only in this JavaScript realm. */
export function currentTransaction(): string | undefined {
  return transactionHandle;
}
