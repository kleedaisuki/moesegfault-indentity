// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { translator } from "../i18n";
import { DraftDiscardDialog, type DraftExitIntent } from "./draft-dialog";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

/** Exercises explicit DOM decisions without substituting window.confirm or claiming browser focus trapping. */
function setup() {
  const button = document.createElement("button");
  document.body.append(button); button.focus();
  const controller = new AbortController();
  const owner = new DraftDiscardDialog(document.body, translator("en"));
  return { button, controller, owner };
}

describe("explicit draft discard dialog", () => {
  it("wraps Tab and Shift+Tab at the two action boundaries without changing the decision", async () => {
    const { owner, controller } = setup();
    const result = owner.request("leave", controller.signal);
    const cancel = document.querySelector<HTMLButtonElement>("dialog .primary")!;
    const discard = document.querySelector<HTMLButtonElement>("dialog .danger")!;
    discard.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    discard.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
    const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    cancel.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(discard);
    expect(document.querySelector<HTMLDialogElement>("dialog")!.open).toBe(true);
    cancel.click();
    expect(await result).toBe(false);
  });

  it("leaves ordinary inner traversal, modified Tab, and Escape to native dialog behavior", async () => {
    const { owner, controller } = setup();
    const result = owner.request("leave", controller.signal);
    const cancel = document.querySelector<HTMLButtonElement>("dialog .primary")!;
    const discard = document.querySelector<HTMLButtonElement>("dialog .danger")!;
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    cancel.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(false);
    discard.focus();
    const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    discard.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(false);
    for (const modifier of ["altKey", "ctrlKey", "metaKey"] as const) {
      const modified = new KeyboardEvent("keydown", { key: "Tab", [modifier]: true, bubbles: true, cancelable: true });
      discard.dispatchEvent(modified);
      expect(modified.defaultPrevented).toBe(false);
    }
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    discard.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    controller.abort();
    expect(await result).toBe(false);
  });

  it.each<[DraftExitIntent, string]>([["leave", "Discard and leave"], ["language", "Discard and change language"], ["sign-out", "Discard and sign out"]])("names the %s action and initially focuses the safe choice", async (intent, label) => {
    const { owner, controller } = setup();
    const result = owner.request(intent, controller.signal);
    const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Unsaved changes");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toContain("unsaved profile");
    expect(document.activeElement?.textContent).toBe("Continue editing");
    const discard = dialog.querySelector<HTMLButtonElement>(".danger")!;
    expect(discard.textContent).toBe(label);
    discard.click();
    expect(await result).toBe(true);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("cancels without granting consent and restores the invoker after command unlocking", async () => {
    const { owner, controller, button } = setup();
    const result = owner.request("sign-out", controller.signal);
    button.disabled = true;
    document.querySelector<HTMLButtonElement>("dialog .primary")!.click();
    expect(await result).toBe(false);
    button.disabled = false;
    await vi.waitFor(() => expect(document.activeElement).toBe(button));
  });

  it.each(["cancel", "close"])("treats native %s as cancellation", async (type) => {
    const { owner, controller } = setup();
    const result = owner.request("leave", controller.signal);
    document.querySelector("dialog")!.dispatchEvent(new Event(type, { cancelable: true }));
    expect(await result).toBe(false);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("rejects competing commands rather than sharing one destructive approval", async () => {
    const { owner, controller } = setup();
    const first = owner.request("leave", controller.signal);
    expect(await owner.request("sign-out", controller.signal)).toBe(false);
    expect(document.querySelectorAll("dialog")).toHaveLength(1);
    document.querySelector<HTMLButtonElement>("dialog .danger")!.click();
    expect(await first).toBe(true);
  });

  it("aborts stale route/principal consent and ignores a retained stale button", async () => {
    const { owner, controller } = setup();
    const first = owner.request("sign-out", controller.signal);
    const stale = document.querySelector<HTMLButtonElement>("dialog .danger")!;
    controller.abort();
    expect(await first).toBe(false);
    const next = owner.request("language", new AbortController().signal);
    stale.click();
    expect(document.querySelector("dialog .danger")?.textContent).toBe("Discard and change language");
    document.querySelector<HTMLButtonElement>("dialog .primary")!.click();
    expect(await next).toBe(false);
    expect(await owner.request("leave", controller.signal)).toBe(false);
  });

  it("fails closed if a browser cannot open a modal instead of allowing silent data loss", async () => {
    const { owner, controller } = setup();
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(() => { throw new DOMException("Unavailable"); });
    expect(await owner.request("leave", controller.signal)).toBe(false);
    expect(document.querySelector("dialog")).toBeNull();
  });
});
