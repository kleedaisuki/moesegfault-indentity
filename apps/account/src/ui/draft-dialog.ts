import type { MessageKey } from "../i18n";
import { el } from "./dom";

/** Explicit destination semantics prevent a generic confirmation from concealing data loss. */
export type DraftExitIntent = "leave" | "language" | "sign-out";

/** One consent owner for all in-app exits; document exits remain the browser's responsibility. */
export class DraftDiscardDialog {
  /** A competing request is rejected, never subscribed to another command's approval. */
  private pending: (() => void) | undefined;
  /** Prevents delayed focus restoration from stealing focus from a newer consent request. */
  private generation = 0;

  /** The persistent shell outlives route forms; translation is evaluated when a request opens. */
  constructor(private readonly root: HTMLElement, private readonly t: (key: MessageKey) => string) {}

  /** Opens a native modal bound to the current route/principal lifetime; cancellation is fail-closed. */
  request(intent: DraftExitIntent, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.pending) return Promise.resolve(false);
    const generation = ++this.generation;
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const cancel = el("button", { className: "button primary", attrs: { type: "button", autofocus: true } }, this.t("continueEditing"));
    const discard = el("button", { className: "button danger", attrs: { type: "button" } }, this.t(intent === "sign-out" ? "discardAndSignOut" : intent === "language" ? "discardAndChangeLanguage" : "discardAndLeave"));
    const dialog = el("dialog", { className: "draft-dialog", attrs: { "aria-labelledby": "draft-dialog-title", "aria-describedby": "draft-dialog-description", "aria-modal": "true" } },
      el("h2", { attrs: { id: "draft-dialog-title" } }, this.t("unsavedChangesTitle")),
      el("p", { attrs: { id: "draft-dialog-description" } }, this.t("discardChanges")),
      el("div", { className: "draft-dialog-actions" }, cancel, discard));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        this.pending = undefined;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(approved && !signal.aborted);
        // Sign-out controls unlock after awaiting consent; restore focus only in the same lifetime.
        if (!approved) setTimeout(() => {
          if (!signal.aborted && this.generation === generation && invoker?.isConnected) invoker.focus({ preventScroll: true });
        }, 0);
      };
      const abort = () => finish(false);
      this.pending = abort;
      signal.addEventListener("abort", abort, { once: true });
      cancel.addEventListener("click", () => finish(false));
      discard.addEventListener("click", () => finish(true));
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
      dialog.addEventListener("close", () => finish(false));
      // Staging traversal reached body after the last action; explicitly wrap this two-button decision.
      dialog.addEventListener("keydown", (event) => {
        if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
        const boundary = event.shiftKey ? cancel : discard;
        if (document.activeElement !== boundary && document.activeElement !== dialog) return;
        event.preventDefault();
        (event.shiftKey ? discard : cancel).focus();
      });
      this.root.append(dialog);
      try { dialog.showModal(); cancel.focus(); }
      catch { finish(false); }
    });
  }
}
