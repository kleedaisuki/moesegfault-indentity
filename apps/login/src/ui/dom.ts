import { el } from "@moesegfault/frontend-shared";

/** 共享 DOM 原语保持既有模块入口不变。Shared DOM primitives retain this module's existing import path. */
export { el, replace } from "@moesegfault/frontend-shared";
export type { Child, ElementOptions } from "@moesegfault/frontend-shared";

/** 创建包含显式 label 的文本输入。Creates a text input with an explicit label. */
export function field(
  label: string,
  name: string,
  options: { type?: string; autocomplete?: string; required?: boolean; placeholder?: string; value?: string; minlength?: string; pattern?: string; icon?: string; accept?: string } = {},
): HTMLLabelElement {
  return el("label", { className: "field" },
    el("span", { className: "field__label" }, label),
    el("span", { className: "field__control", dataset: { icon: options.icon ?? "" } },
      el("input", { attrs: { name, type: options.type ?? "text", autocomplete: options.autocomplete ?? "off", required: options.required, placeholder: options.placeholder, value: options.value, minlength: options.minlength, pattern: options.pattern, accept: options.accept } }),
    ),
  );
}

/** 创建带标题的页面状态，供 loading/error/empty/success 统一呈现。Creates a titled state panel for loading/error/empty/success. */
export function statePanel(
  kind: "loading" | "error" | "empty" | "success" | "info",
  title: string,
  detail: string,
  action?: HTMLElement,
): HTMLElement {
  return el("section", {
    className: `state state--${kind}`,
    attrs: { role: kind === "error" ? "alert" : "status", "aria-live": kind === "loading" ? "polite" : "assertive" },
  },
  el("div", { className: "state__mark", attrs: { "aria-hidden": "true" } }, stateIcon(kind)),
  el("div", {}, el("h2", {}, title), el("p", {}, detail), action),
  );
}

/** 返回状态对应的纯文本图标。Returns the plain-text icon corresponding to a state. */
function stateIcon(kind: "loading" | "error" | "empty" | "success" | "info"): string {
  return { loading: "◌", error: "!", empty: "◇", success: "✓", info: "i" }[kind];
}

/** 将未知错误转成不泄露请求载荷的文案。Turns an unknown error into text that does not leak request payloads. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生了未知错误，请重试。";
}

/** 设置按钮忙碌状态并防止重复提交。Sets a button busy and prevents duplicate submission. */
export function setButtonBusy(button: HTMLButtonElement, busy: boolean, busyLabel = "处理中…"): void {
  if (busy) {
    button.dataset.idleLabel = button.textContent ?? "";
    button.textContent = busyLabel;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    return;
  }
  button.textContent = button.dataset.idleLabel ?? button.textContent;
  button.disabled = false;
  button.removeAttribute("aria-busy");
}

/** 格式化 API 时间；非法值明确显示未知。Formats an API timestamp and explicitly marks invalid values. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "尚无记录";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "未知时间" : new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
