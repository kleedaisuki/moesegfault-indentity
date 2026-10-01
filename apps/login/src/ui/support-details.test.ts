// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate, type Locale } from "../i18n";
import { failureReceipt } from "../support-receipt";
import { supportDetails } from "./support-details";

const receipt = failureReceipt(new Error("secret"), "password_authentication", "login.moesegfault.dev", "unknown", 0);
const copy = (locale: Locale) => ({ summary: translate(locale, "supportSummary"), privacy: translate(locale, "supportPrivacy"), copy: translate(locale, "supportCopy"), copied: translate(locale, "supportCopied"), failed: translate(locale, "supportCopyFailed") });
afterEach(() => document.body.replaceChildren());

describe.each(["zh-CN", "en", "ja"] as const)("opt-in support details in %s", (locale) => {
  it("uses a closed native details/summary and never copies on render or expansion", () => {
    const write = vi.fn(async () => undefined);
    const panel = supportDetails(receipt, copy(locale), write);
    document.body.append(panel);
    expect(panel.tagName).toBe("DETAILS");
    expect(panel.hasAttribute("open")).toBe(false);
    expect(panel.querySelector("summary")?.textContent).toBe(copy(locale).summary);
    panel.setAttribute("open", "");
    expect(write).not.toHaveBeenCalled();
    expect(panel.querySelector("button")?.type).toBe("button");
  });
  it("copies only the allowlisted receipt after a deliberate click", async () => {
    const write = vi.fn(async () => undefined);
    const panel = supportDetails(receipt, copy(locale), write);
    panel.querySelector("button")?.click();
    await vi.waitFor(() => expect(panel.querySelector('[role="status"]')?.textContent).toBe(copy(locale).copied));
    expect(write).toHaveBeenCalledExactlyOnceWith(JSON.stringify(receipt, null, 2));
  });
  it("keeps original error and selectable receipt on clipboard rejection", async () => {
    const original = document.createElement("p"); original.textContent = "Authentication failed";
    const panel = supportDetails(receipt, copy(locale), async () => { throw new Error("secret-clipboard"); });
    document.body.append(original, panel);
    panel.querySelector("button")?.click();
    await vi.waitFor(() => expect(panel.querySelector('[role="status"]')?.textContent).toBe(copy(locale).failed));
    expect(original.textContent).toBe("Authentication failed");
    expect(panel.querySelector("pre")?.textContent).toBe(JSON.stringify(receipt, null, 2));
    expect(panel.querySelector("button")?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain("secret-clipboard");
  });
});
