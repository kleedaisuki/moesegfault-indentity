// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { el, replace } from "./dom";

describe("shared DOM helpers", () => {
  it("renders untrusted text literally and preserves attribute, dataset and event semantics", () => {
    const click = vi.fn();
    const button = el("button", {
      className: "action",
      attrs: { disabled: true, hidden: false, title: "safe" },
      dataset: { action: "continue" },
      on: { click },
    }, "<script>alert(1)</script>", 3, false, null, undefined);
    expect(button.outerHTML).not.toContain("<script>");
    expect(button.textContent).toBe("<script>alert(1)</script>3");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.hasAttribute("hidden")).toBe(false);
    expect(button.dataset.action).toBe("continue");
    el("button", { on: { click } }).click();
    expect(click).toHaveBeenCalledOnce();
  });

  it("replaces content while omitting empty placeholders", () => {
    const container = el("div", {}, "old");
    replace(container, el("span", {}, "new"), false, null, undefined, 2);
    expect(container.innerHTML).toBe("<span>new</span>2");
  });
});
