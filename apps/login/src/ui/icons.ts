import { el } from "./dom";

/** 本地内联 SVG 图标名。Names of local inline SVG icons. */
export type IconName = "star" | "key" | "github" | "mail" | "lock" | "user" | "moon" | "globe" | "external";

const paths: Record<IconName, string> = {
  star: "M12 2.5l2.4 6.1 6.6.4-5.1 4.2 1.7 6.4-5.6-3.5-5.6 3.5 1.7-6.4L3 9l6.6-.4L12 2.5z",
  key: "M15.5 3a5.5 5.5 0 00-5.2 7.3L3 17.6V21h3.4l1.4-1.4V18h1.6l1.5-1.5V15h1.6l1.3-1.3A5.5 5.5 0 1015.5 3zm2 5.5a2 2 0 110-4 2 2 0 010 4z",
  github: "M12 .8a11.4 11.4 0 00-3.6 22.2c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.6.1-3.1 0 0 1-.3 3.1 1.2a10.7 10.7 0 015.7 0C16.3 5.1 17.3 5.4 17.3 5.4c.6 1.5.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.8 5.4-5.5 5.7.4.4.8 1.1.8 2.2v3c0 .4.2.7.8.6A11.4 11.4 0 0012 .8z",
  mail: "M3 5h18v14H3V5zm2 2v.5l7 5 7-5V7H5zm14 10V10l-7 5-7-5v7h14z", lock: "M6 10V8a6 6 0 0112 0v2h2v12H4V10h2zm3 0h6V8a3 3 0 00-6 0v2z",
  user: "M12 12a5 5 0 100-10 5 5 0 000 10zm9 10a9 9 0 00-18 0h18z", moon: "M20 15.4A8 8 0 018.6 4a8.5 8.5 0 1011.4 11.4z",
  globe: "M12 2a10 10 0 100 20 10 10 0 000-20zm6.9 6h-3.1a15 15 0 00-1.3-3.3A8.1 8.1 0 0118.9 8zM12 4c.8.9 1.5 2.2 1.8 4h-3.6c.3-1.8 1-3.1 1.8-4zM4 12c0-.7.1-1.4.3-2h3.5a16 16 0 000 4H4.3A8 8 0 014 12zm1.1 4h3.1a15 15 0 001.3 3.3A8.1 8.1 0 015.1 16zm3.1-8H5.1a8.1 8.1 0 014.4-3.3A15 15 0 008.2 8zM12 20c-.8-.9-1.5-2.2-1.8-4h3.6c-.3 1.8-1 3.1-1.8 4zm2.1-6H9.9a13 13 0 010-4h4.2a13 13 0 010 4zm.4 5.3a15 15 0 001.3-3.3h3.1a8.1 8.1 0 01-4.4 3.3zm1.7-5.3a16 16 0 000-4h3.5a8 8 0 010 4h-3.5z",
  external: "M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3zM5 5h6v2H5v12h12v-6h2v8H3V5h2z",
};

/** 创建无外部请求的装饰性 SVG。Creates a decorative SVG without external requests. */
export function icon(name: IconName, className = "icon"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", paths[name]); svg.append(path);
  return svg;
}

/** 创建图标与文本组合。Creates an icon-and-label fragment. */
export function iconLabel(name: IconName, label: string): DocumentFragment {
  const fragment = document.createDocumentFragment(); fragment.append(icon(name), el("span", {}, label)); return fragment;
}
