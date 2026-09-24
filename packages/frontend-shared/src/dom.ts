/** DOM 工具可接受的子节点。Child value accepted by the DOM helpers. */
export type Child = Node | string | number | false | null | undefined;

/** 安全元素属性、数据集和事件声明。Safe element attributes, dataset, and event declarations. */
export interface ElementOptions {
  className?: string;
  attrs?: Record<string, string | boolean | undefined>;
  dataset?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, EventListener>>;
}

/**
 * 只用文本节点组装 DOM，不将 API 文本解析为 HTML。
 * Builds DOM using text nodes, never parsing API text as HTML.
 *
 * @example
 * ```ts
 * el("p", { className: "notice" }, untrustedText);
 * ```
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === false || value === undefined) continue;
    node.setAttribute(name, value === true ? "" : value);
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) node.dataset[name] = value;
  for (const [event, listener] of Object.entries(options.on ?? {})) node.addEventListener(event, listener as EventListener);
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 原子替换容器内容，忽略空占位值。Atomically replaces content, omitting empty placeholders. */
export function replace(container: Element, ...children: Child[]): void {
  container.replaceChildren(...children
    .filter((child): child is Node | string | number => child !== false && child !== null && child !== undefined)
    .map((child) => child instanceof Node ? child : document.createTextNode(String(child))));
}
