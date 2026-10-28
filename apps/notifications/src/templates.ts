import { escapeHtml } from "@moesegfault/service-platform";
import type { EmailContent, NotificationMessage } from "./message";

const copy = {
  en: {
    verification: "Verify your email", verificationBody: "Enter this code to continue.",
    warning: "Never share this code. If you did not request it, you can ignore this email.",
    expires: "Valid until", respondBy: "Respond by", linkExpires: "Link valid until", security: "Account security", notification: "A note from moeSegFault",
    decision: "Your response is requested", action: "Open", footer: "A little closer, together.",
  },
  "zh-CN": {
    verification: "验证你的邮箱", verificationBody: "输入验证码，继续下一步。",
    warning: "请勿向他人透露验证码。如果这不是你的操作，忽略这封邮件即可。",
    expires: "有效期至", respondBy: "回复截止", linkExpires: "链接有效期至", security: "账户安全", notification: "来自 moeSegFault 的消息",
    decision: "等待你的回应", action: "查看", footer: "让彼此，再靠近一点。",
  },
  ja: {
    verification: "メールアドレスの確認", verificationBody: "このコードを入力して続行してください。",
    warning: "コードを他の人と共有しないでください。心当たりがなければ、このメールを無視してください。",
    expires: "有効期限", respondBy: "回答期限", linkExpires: "リンクの有効期限", security: "アカウントの安全", notification: "moeSegFault からのお知らせ",
    decision: "ご回答をお待ちしています", action: "開く", footer: "一緒に、もう少し近くへ。",
  },
} as const;

const paragraphStyle = "margin:0 0 24px;line-height:1.75;font-size:16px;color:#523b31;overflow-wrap:anywhere";

function expiryText(message: NotificationMessage): string {
  const words = copy[message.locale];
  const format = (label: string, timestamp?: number): string => timestamp
    ? `${label} ${new Date(timestamp * 1000).toISOString().replace("T", " ").replace(/\.000Z$/, " UTC")}` : "";
  if (message.template === "verification") return format(words.expires, message.expires_at);
  if (message.action?.expires_at) return format(message.template === "decision" ? words.respondBy : words.linkExpires, message.action.expires_at);
  if (message.template === "decision") return format(words.expires, message.expires_at);
  return "";
}

export function renderEmail(message: NotificationMessage, messageId: string): EmailContent {
  const words = copy[message.locale];
  const title = message.title ?? words[message.template];
  const body = message.body ?? (message.template === "verification" ? words.verificationBody : "");
  const expiry = expiryText(message);
  const code = message.template === "verification" ? message.code : undefined;
  const codeBlock = code
    ? `<div style="margin:8px 0 24px;padding:24px 12px;border:1px solid #e4c7b5;border-radius:12px;background:#fff4e8;text-align:center;font:700 30px/1.4 ui-monospace,Consolas,monospace;letter-spacing:.16em;color:#a53b20">${escapeHtml(code)}</div>`
    : "";
  const action = message.action;
  const button = action
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 24px"><tr><td bgcolor="#ad3f23" style="border-radius:10px"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:14px 24px;color:#ffffff;font-weight:700;text-decoration:none;line-height:1.4">${escapeHtml(action.label || words.action)}</a></td></tr></table>`
    : "";
  const warning = code ? words.warning : "";
  const html = `<!doctype html><html lang="${escapeHtml(message.locale)}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#fffaf2;color:#26110b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC','Microsoft YaHei',sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fffaf2"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px"><tr><td style="padding:0 8px 24px;font-size:19px;font-weight:800;color:#26110b"><span style="color:#bd4525">✦</span>&nbsp; moeSegFault</td></tr>
<tr><td style="padding:32px 24px;border:1px solid #e4c7b5;border-top:4px solid #ed8057;border-radius:16px;background:#fffdf8">
<h1 style="margin:0 0 20px;font-family:Georgia,'Noto Serif SC',serif;font-size:28px;line-height:1.3;color:#26110b;overflow-wrap:anywhere">${escapeHtml(title)}</h1>
${body ? `<p style="${paragraphStyle}">${escapeHtml(body).replace(/\n/g, "<br>")}</p>` : ""}${codeBlock}${button}
${expiry ? `<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#755446">${escapeHtml(expiry)}</p>` : ""}
${warning ? `<p style="margin:0;font-size:13px;line-height:1.7;color:#755446">${escapeHtml(warning)}</p>` : ""}
</td></tr><tr><td style="padding:24px 8px;font-size:12px;line-height:1.8;color:#755446">${escapeHtml(words.footer)}<br>moeSegFault · ${escapeHtml(message.sender)}@moesegfault.dev</td></tr></table>
</td></tr></table></body></html>`;
  const text = ["moeSegFault", title, body, code, expiry, warning, action ? `${action.label}: ${action.url}` : "", `${message.sender}@moesegfault.dev`]
    .filter(Boolean).join("\n\n");
  return {
    from: { email: `${message.sender}@moesegfault.dev`, name: "moeSegFault" },
    to: message.to,
    subject: message.subject ?? title,
    html,
    text,
    headers: { "X-moeSegFault-Notification-ID": messageId },
  };
}
