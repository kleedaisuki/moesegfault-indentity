// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installRouter } from "./router";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("route-link draft decisions", () => {
  it("ignores repeated links while an explicit decision is pending", async () => {
    let finish!: (approved: boolean) => void;
    const decide = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const render = vi.fn();
    const push = vi.spyOn(history, "pushState").mockImplementation(() => undefined);
    const dispose = installRouter(render, decide);
    document.body.innerHTML = '<a data-route href="/security">Security</a><a data-route href="/apps">Apps</a>';
    document.querySelectorAll("a").forEach((link) => link.click());
    expect(decide).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    finish(true);
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(push.mock.calls[0]?.[2]).toContain("/security");
    dispose();
  });

  it.each(["traverse", "dispose"])("rejects late approval after %s", async (action) => {
    let finish!: (approved: boolean) => void;
    const render = vi.fn();
    const push = vi.spyOn(history, "pushState");
    const dispose = installRouter(render, () => new Promise<boolean>((resolve) => { finish = resolve; }));
    document.body.innerHTML = '<a data-route href="/security">Security</a>';
    document.querySelector("a")!.click();
    if (action === "traverse") window.dispatchEvent(new PopStateEvent("popstate"));
    else dispose();
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(push).not.toHaveBeenCalled();
    if (action === "traverse") expect(render).toHaveBeenCalledExactlyOnceWith("preserve");
    else expect(render).not.toHaveBeenCalled();
    dispose();
  });

  it("leaves history and the rendered form intact when navigation is cancelled", () => {
    const render = vi.fn();
    const decide = vi.fn(() => false);
    const push = vi.spyOn(history, "pushState");
    const dispose = installRouter(render, decide);
    document.body.innerHTML = '<a data-route href="/security">Security</a>';
    document.querySelector("a")!.click();
    expect(decide).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    dispose();
  });

  it("navigates once after discarding and does not intercept new-tab or download links", async () => {
    const render = vi.fn();
    const decide = vi.fn(() => true);
    const push = vi.spyOn(history, "pushState").mockImplementation(() => undefined);
    const dispose = installRouter(render, decide);
    document.body.innerHTML = '<a data-route href="/security">Security</a><a data-route target="_blank" href="/profile">New tab</a><a data-route download href="/apps">Download</a>';
    const links = document.querySelectorAll("a");
    // Suppress the DOM emulator's real fetch only after the router has inspected the click.
    const preventNativeNavigation = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("click", preventNativeNavigation);
    links[0]!.click(); links[1]!.click(); links[2]!.click();
    document.removeEventListener("click", preventNativeNavigation);
    expect(decide).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith("discard-visible");
    dispose();
  });

  it("preserves drafts on native history events without asking to cancel the traversal", () => {
    const render = vi.fn();
    const decide = vi.fn(() => false);
    const dispose = installRouter(render, decide);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(render).toHaveBeenCalledWith("preserve");
    expect(decide).not.toHaveBeenCalled();
    dispose();
  });

  it("does not discard the current form when clicking the current route", () => {
    const render = vi.fn();
    const decide = vi.fn(() => true);
    const dispose = installRouter(render, decide);
    const link = document.createElement("a");
    link.dataset.route = ""; link.href = location.href;
    document.body.append(link); link.click();
    expect(decide).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    dispose();
  });
});
