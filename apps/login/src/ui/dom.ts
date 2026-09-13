/** 可被 DOM helper 接受的子节点。Child value accepted by the DOM helper. */
export type Child = Node | string | number | false | null | undefined;

/** 元素属性、dataset 与事件的简洁声明。Compact declaration of element attributes, dataset, and events. */
export interface ElementOptions {
  className?: string;
  attrs?: Record<string, string | boolean | undefined>;
  dataset?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, EventListener>>;
}

/**
 * 通过 text nodes 构建 DOM，杜绝把 API 文本拼入 HTML。
 * Builds DOM with text nodes so API text is never interpolated into HTML.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === undefined || value === false) continue;
    if (value === true) node.setAttribute(name, "");
    else node.setAttribute(name, value);
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) node.dataset[name] = value;
  for (const [event, listener] of Object.entries(options.on ?? {})) {
    node.addEventListener(event, listener as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 清空容器并原子替换可见内容。Clears a container and atomically replaces visible content. */
export function replace(container: Element, ...children: Child[]): void {
  container.replaceChildren(...children.filter((child): child is Node | string | number =>
    child !== null && child !== undefined && child !== false,
  ).map((child) => child instanceof Node ? child : document.createTextNode(String(child))));
}

/** 创建包含显式 label 的文本输入。Creates a text input with an explicit label. */
export function field(
  label: string,
  name: string,
  options: { type?: string; autocomplete?: string; required?: boolean; placeholder?: string; value?: string } = {},
): HTMLLabelElement {
  return el("label", { className: "field" },
    el("span", { className: "field__label" }, label),
    el("input", {
      attrs: {
        name,
        type: options.type ?? "text",
        autocomplete: options.autocomplete ?? "off",
        required: options.required,
        placeholder: options.placeholder,
        value: options.value,
      },
    }),
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
