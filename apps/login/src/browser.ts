/** 常见 App 内嵌浏览器的保守识别结果。Conservative detection result for common in-app browsers. */
export interface BrowserContext { inApp: boolean; name?: string }

/** 识别常见内嵌 WebView；仅用于提示，不阻断认证。Detects common WebViews for guidance without blocking authentication. */
export function detectInAppBrowser(userAgent: string): BrowserContext {
  const match = userAgent.match(/MicroMessenger|QQ\//i) ?? userAgent.match(/(FBAN|FBAV|Instagram|Line\/|WebView|; wv\))/i);
  if (!match) return { inApp: false };
  const token = match[0].toLowerCase();
  const name = token.includes("micromessenger") ? "WeChat" : token.startsWith("qq") ? "QQ" : token.includes("instagram") ? "Instagram" : "App WebView";
  return { inApp: true, name };
}
