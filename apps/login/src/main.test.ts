// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPage } from "./pages";

vi.mock("./pages", () => ({ renderPage: vi.fn() }));

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("Login route render ownership", () => {
  it("does not move focus when an aborted previous route finishes late", async () => {
    const completions: (() => void)[] = [];
    vi.mocked(renderPage).mockImplementation(() => new Promise<void>(resolve => { completions.push(resolve); }));
    document.body.innerHTML = '<div id="app"></div>';
    history.replaceState(null, "", "/passkey/enroll");
    await import("./main");
    expect(renderPage).toHaveBeenCalledOnce();
    const firstSignal = vi.mocked(renderPage).mock.calls[0]![3];
    const focus = vi.spyOn(document.querySelector("main")!, "focus");
    history.pushState(null, "", "/login");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(renderPage).toHaveBeenCalledTimes(2);
    expect(firstSignal.aborted).toBe(true);
    completions[0]!();
    await Promise.resolve();
    expect(focus).not.toHaveBeenCalled();
    completions[1]!();
    await Promise.resolve();
    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    const currentSignal = vi.mocked(renderPage).mock.calls[1]![3];
    const language = document.querySelector<HTMLSelectElement>(".toolbar-select")!;
    language.value = language.value === "en" ? "ja" : "en";
    language.dispatchEvent(new Event("change"));
    expect(renderPage).toHaveBeenCalledTimes(2);
    expect(currentSignal.aborted).toBe(false);
    expect(document.activeElement).toBe(document.querySelector(".toolbar-select"));
    expect(focus).toHaveBeenCalledOnce();
  });
});
