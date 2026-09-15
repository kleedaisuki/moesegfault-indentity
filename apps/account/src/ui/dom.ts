/** DOM helper 可接受的子节点。Child accepted by the DOM helper. */
export type Child = Node | string | number | false | null | undefined;

/** 简洁的安全 DOM 属性声明。Compact safe DOM attribute declaration. */
export interface ElementOptions { className?: string; attrs?: Record<string, string | boolean | undefined>; dataset?: Record<string, string>; }

/** 用 text node 组装 DOM，API 文本不会进入 HTML。Builds DOM with text nodes so API text never enters HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, options: ElementOptions = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  for (const [key, value] of Object.entries(options.attrs ?? {})) { if (value === false || value === undefined) continue; node.setAttribute(key, value === true ? "" : value); }
  for (const [key, value] of Object.entries(options.dataset ?? {})) node.dataset[key] = value;
  for (const child of children) if (child !== false && child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

/** 原子替换容器内容。Atomically replaces container content. */
export function replace(container: Element, ...children: Child[]): void { container.replaceChildren(...children.filter((x): x is Node | string | number => x !== false && x !== null && x !== undefined).map((x) => x instanceof Node ? x : document.createTextNode(String(x)))); }

/** 创建本地 SVG sprite 图标。Creates a local SVG sprite icon. */
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("href", `/icons/sprite.svg#${name}`); svg.append(use); return svg;
}

/** 格式化用户区域的时间。Formats time in the user's locale. */
export function formatTime(value: string | null | undefined, locale: string): string { const date = value ? new Date(value) : undefined; return !date || Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date); }

/** 把按钮切换到忙碌状态。Toggles a button's busy state. */
export function busy(button: HTMLButtonElement, value: boolean): void { button.disabled = value; button.setAttribute("aria-busy", String(value)); }
