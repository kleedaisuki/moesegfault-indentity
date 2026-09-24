/** 共享 DOM 原语保持既有模块入口不变。Shared DOM primitives retain this module's existing import path. */
export { el, replace } from "@moesegfault/frontend-shared";
export type { Child, ElementOptions } from "@moesegfault/frontend-shared";

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
