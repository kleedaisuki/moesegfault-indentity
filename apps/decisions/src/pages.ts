import { escapeHtml } from "@moesegfault/service-platform";
import type { DecisionInput } from "./model";

const translations = {
  en: { submit: "Confirm and submit", choose: "Your decision", done: "Response submitted", doneBody: "You can close this page.", expired: "This link is no longer available", home: "Decisions", homeBody: "Open the link in your moeSegFault email to respond.", confirm: "I confirm this response" },
  "zh-CN": { submit: "确认并提交", choose: "你的决定", done: "已提交回复", doneBody: "可以关闭此页面了。", expired: "此链接已失效", home: "决策中心", homeBody: "打开 moeSegFault 邮件中的链接以回复。", confirm: "我确认此回复" },
  ja: { submit: "確認して送信", choose: "あなたの選択", done: "回答を送信しました", doneBody: "このページを閉じてください。", expired: "このリンクは利用できません", home: "意思決定", homeBody: "moeSegFault のメールのリンクから回答してください。", confirm: "この回答を確認しました" },
};

export function page(title: string, content: string, locale = "en"): string {
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · moeSegFault</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#26110b;background:#fffaf2;font-synthesis:none;--surface:#fffdf8;--edge:#d9b8a6;--muted:#805648;--accent:#bd4525}*{box-sizing:border-box}body{margin:0;min-height:100svh;display:flex;flex-direction:column}header{padding:28px clamp(20px,5vw,72px);font-weight:760;letter-spacing:-.04em;font-size:23px}header span{color:var(--accent)}main{width:min(100% - 32px,640px);margin:40px auto 80px;padding:clamp(24px,5vw,48px);border:1px solid var(--edge);border-radius:28px;background:var(--surface);box-shadow:0 14px 60px #37215408}h1{font-size:clamp(28px,5vw,38px);line-height:1.15;letter-spacing:-.035em;margin:0 0 24px}p{line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted)}form{margin-top:32px;display:grid;gap:24px}fieldset{padding:0;border:0;margin:0;display:grid;gap:12px}legend{font-weight:650;margin-bottom:14px}.choice{display:flex;align-items:center;gap:12px;border:1px solid var(--edge);border-radius:14px;padding:16px;cursor:pointer}.choice:has(input:checked){border-color:var(--accent);background:#f27a5014}.field{display:grid;gap:9px;font-weight:600}input:not([type=radio]):not([type=checkbox]),select,textarea{width:100%;font:inherit;padding:13px;border:1px solid var(--edge);border-radius:12px;background:var(--surface);color:inherit}textarea{min-height:120px;resize:vertical}input[type=radio],input[type=checkbox]{accent-color:var(--accent);width:19px;height:19px;flex-shrink:0}.confirm{display:flex;gap:10px;align-items:center;line-height:1.5}button{border:0;border-radius:14px;background:var(--accent);color:#fff;padding:16px 24px;font:inherit;font-weight:650;cursor:pointer;min-height:52px}:focus-visible{outline:3px solid #e66a3f;outline-offset:4px}footer{padding:24px;margin-top:auto;text-align:center;color:var(--muted);font-size:13px}@media(prefers-color-scheme:dark){:root{color:#fffaf2;background:#19100e;--surface:#30201b;--edge:#805648;--muted:#d9b8a6;--accent:#ffb18c}button{color:#26110b}}@media(max-width:420px){main{margin-top:16px;border-radius:20px}header{padding-top:22px}h1{font-size:29px}}</style></head><body><header>moe<span>SegFault</span></header><main>${content}</main><footer>moeSegFault</footer></body></html>`;
}

export function decisionPage(input: DecisionInput, token: string, csrf: string): string {
  const t = translations[input.locale];
  const choices = input.choices ? `<fieldset><legend>${t.choose}</legend>${input.choices.map((choice) => `<label class="choice"><input type="radio" name="choice" value="${escapeHtml(choice.value)}" required><span>${escapeHtml(choice.label)}</span></label>`).join("")}</fieldset>` : "";
  const fields = (input.fields ?? []).map((field) => {
    const name = escapeHtml(field.name);
    const label = escapeHtml(field.label);
    const required = field.required ? " required" : "";
    if (field.type === "checkbox") return `<label class="confirm"><input type="checkbox" name="${name}"${required}>${label}</label>`;
    if (field.type === "textarea") return `<label class="field">${label}<textarea name="${name}" maxlength="4000"${required}></textarea></label>`;
    if (field.type === "select") return `<label class="field">${label}<select name="${name}"${required}><option value=""></option>${field.options?.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}</select></label>`;
    return `<label class="field">${label}<input type="${field.type}" name="${name}"${field.type === "number" ? " step=any" : " maxlength=4000"}${required}></label>`;
  }).join("");
  return page(input.title, `<h1>${escapeHtml(input.title)}</h1>${input.body ? `<p>${escapeHtml(input.body)}</p>` : ""}<form method="post" action="/d/${token}/submit"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${choices}${fields}<button type="submit">${t.submit}</button></form>`, input.locale);
}

export function completedPage(locale: DecisionInput["locale"]): string {
  const t = translations[locale];
  return page(t.done, `<h1>${t.done}</h1><p>${t.doneBody}</p>`, locale);
}

export function expiredPage(): string {
  return page(translations.en.expired, `<h1>${translations.en.expired}</h1>`);
}

export function landingPage(): string {
  const t = translations.en;
  return page(t.home, `<h1>${t.home}</h1><p>${t.homeBody}</p>`);
}
