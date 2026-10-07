// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { captureProfileDraft, captureProfileValues, profileChangesSince, hasUnsavedChanges, installDraftExitWarning, restoreProfileDraft, trackFormDraft } from "./draft";

/** Builds a registered form without persisting any values outside the DOM. */
function fixture() {
  const root = document.createElement("main");
  root.innerHTML = '<form><input name="display_name" value="Klee"><textarea name="links">https://example.com</textarea></form>';
  const form = root.querySelector("form")!;
  const field = form.querySelector("input")!;
  const accept = trackFormDraft(form);
  return { root, form, field, accept };
}

describe("profile draft baseline", () => {
  it("captures discard approval without accepting it and retains only later differences", () => {
    const { root, field } = fixture();
    field.value = "Approved discard";
    const approved = captureProfileValues(root)!;
    expect(approved.get("links")).toBe("https://example.com");
    expect(hasUnsavedChanges(root)).toBe(true);
    expect(profileChangesSince(captureProfileValues(root)!, approved).size).toBe(0);
    field.value = "Typed after approval";
    expect(Array.from(profileChangesSince(captureProfileValues(root)!, approved))).toEqual([["display_name", "Typed after approval"]]);
    expect(hasUnsavedChanges(root)).toBe(true);
  });
  it("accepts only a confirmed submitted subset while retaining failed and newer edits", () => {
    const { root, form, field, accept } = fixture();
    form.querySelector("textarea")!.value = "https://example.com/unsaved";
    field.value = "Submitted saved name";
    const submitted = new FormData(form);
    field.value = "Newer name";
    accept(submitted, ["display_name"]);
    expect(Array.from(captureProfileDraft(root)!)).toEqual([["display_name", "Newer name"], ["links", "https://example.com/unsaved"]]);
    field.value = "Submitted saved name";
    expect(Array.from(captureProfileDraft(root)!)).toEqual([["links", "https://example.com/unsaved"]]);
    expect(hasUnsavedChanges(root)).toBe(true);
  });
  it("rehydrates only edited fields into a fresh server-backed form and keeps them dirty", () => {
    const old = fixture();
    old.field.value = "Local draft";
    const draft = captureProfileDraft(old.root)!;
    expect(Array.from(draft)).toEqual([["display_name", "Local draft"]]);
    const fresh = fixture();
    fresh.field.value = "Updated on server";
    fresh.form.querySelector("textarea")!.value = "https://example.org/server-added-link";
    trackFormDraft(fresh.form);
    restoreProfileDraft(fresh.root, draft);
    expect(fresh.field.value).toBe("Local draft");
    expect(fresh.form.querySelector("textarea")!.value).toBe("https://example.org/server-added-link");
    expect(hasUnsavedChanges(fresh.root)).toBe(true);
    fresh.field.value = "Updated on server";
    expect(hasUnsavedChanges(fresh.root)).toBe(false);
  });

  it("never captures credentials, hidden proofs, uploads, or unregistered forms", () => {
    const { root, form } = fixture();
    form.insertAdjacentHTML("beforeend", '<input type="password" name="password"><input type="hidden" name="csrf"><input type="file" name="avatar"><select name="visibility"><option value="private">Private</option><option value="public">Public</option></select>');
    trackFormDraft(form);
    form.querySelector<HTMLInputElement>('[name="password"]')!.value = "Do not retain";
    form.querySelector<HTMLInputElement>('[name="csrf"]')!.value = "New proof";
    form.querySelector<HTMLSelectElement>("select")!.value = "public";
    expect(Array.from(captureProfileDraft(root)!)).toEqual([["visibility", "public"]]);
    root.innerHTML = '<form><input name="display_name" value="Unregistered"></form>';
    expect(captureProfileDraft(root)).toBeUndefined();
    restoreProfileDraft(root, new Map([["display_name", "Do not inject"]]));
    expect(root.querySelector("input")!.value).toBe("Unregistered");
  });

  it("distinguishes a clean registered form from a refresh failure without a form", () => {
    const { root } = fixture();
    expect(captureProfileDraft(root)?.size).toBe(0);
    root.replaceChildren();
    expect(captureProfileDraft(root)).toBeUndefined();
  });

  it("detects live edits and treats reverting values as clean", () => {
    const { root, field } = fixture();
    expect(hasUnsavedChanges(root)).toBe(false);
    field.value = "Changed without input event";
    expect(hasUnsavedChanges(root)).toBe(true);
    field.value = "Klee";
    expect(hasUnsavedChanges(root)).toBe(false);
  });

  it("accepts the saved snapshot, not newer values typed during the request", () => {
    const { root, form, field, accept } = fixture();
    field.value = "Submitted";
    const submitted = new FormData(form);
    field.value = "Still unsaved";
    accept(submitted);
    expect(hasUnsavedChanges(root)).toBe(true);
    field.value = "Submitted";
    expect(hasUnsavedChanges(root)).toBe(false);
  });

  it("ignores unregistered sensitive forms and collected page contents", () => {
    const { root, field } = fixture();
    field.value = "Changed";
    root.innerHTML = '<form><input name="password" value="secret"></form>';
    expect(hasUnsavedChanges(root)).toBe(false);
  });

  it("warns only for a dirty document exit and supports disposal", () => {
    const { root, field } = fixture();
    const dispose = installDraftExitWarning(root);
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    field.value = "Changed";
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    dispose();
    const disposed = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(disposed);
    expect(disposed.defaultPrevented).toBe(false);
  });

  it("warns while an in-memory draft is waiting for refresh retry without a rendered form", () => {
    const root = document.createElement("main");
    const dispose = installDraftExitWarning(root, () => true);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    dispose();
  });
});
