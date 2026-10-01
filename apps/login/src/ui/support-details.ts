import type { SupportReceipt } from "../support-receipt";
import { el } from "./dom";

/** Localized copy for an explicitly opted-in diagnostic, never automatic transmission. */
export interface SupportDetailsCopy {
  summary: string;
  privacy: string;
  copy: string;
  copied: string;
  failed: string;
}

/**
 * Native details/summary keeps the failure compact and keyboard accessible.
 * Copy failure preserves both the receipt and original error; the pre remains selectable.
 */
export function supportDetails(receipt: SupportReceipt, copy: SupportDetailsCopy, writeText: (text: string) => Promise<void> = (text) => navigator.clipboard.writeText(text)): HTMLElement {
  const text = JSON.stringify(receipt, null, 2);
  const status = el("p", { attrs: { role: "status", "aria-live": "polite" } });
  const button = el("button", { className: "button button--secondary", attrs: { type: "button" } }, copy.copy);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await writeText(text); status.textContent = copy.copied; }
    catch { status.textContent = copy.failed; }
    finally { button.disabled = false; }
  });
  return el("details", { className: "support-details" },
    el("summary", {}, copy.summary), el("p", { className: "hint" }, copy.privacy),
    el("pre", {}, text), button, status);
}
