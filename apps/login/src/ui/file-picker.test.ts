// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessedAvatar } from "@moesegfault/frontend-shared";
import { translate } from "../i18n";
import type { Locale } from "../i18n";
import { avatarFilePicker, AVATAR_ACCEPT, type FilePickerCopy } from "./file-picker";

const locales = ["zh-CN", "en", "ja"] as const satisfies readonly Locale[];

afterEach(() => document.body.replaceChildren());

function copy(locale: Locale): FilePickerCopy {
  return {
    label: translate(locale, "avatar"), choose: translate(locale, "chooseAvatar"), empty: translate(locale, "noAvatarSelected"),
    processing: translate(locale, "avatarProcessing"), ready: translate(locale, "avatarReady"), failed: translate(locale, "avatarProcessingFailed"),
    previewAlt: translate(locale, "avatarPreviewAlt"),
  };
}

function choose(input: HTMLInputElement, file: File): void {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change"));
}

function processed(name = "avatar.webp", url = "blob:processed", dispose = vi.fn()): ProcessedAvatar {
  const file = new File([new Uint8Array(2048)], name, { type: "image/webp" });
  return {
    file, blob: file, previewUrl: url, dispose,
    metadata: { inputBytes: 4096, outputBytes: 2048, sourceWidth: 1600, sourceHeight: 900, edge: 900, mediaType: "image/webp" },
  };
}

describe.each(locales)("avatar file picker in %s", (locale) => {
  it("keeps an explicitly labelled, focusable native control", () => {
    const picker = avatarFilePicker(copy(locale), { process: async () => processed() });
    const form = document.createElement("form");
    form.append(picker);
    document.body.append(form);

    const input = form.querySelector<HTMLInputElement>('input[type="file"][name="avatar"]');
    expect(input).not.toBeNull();
    expect(input?.classList.contains("visually-hidden")).toBe(true);
    expect(input?.hidden).toBe(false);
    expect(input?.tabIndex).toBe(0);
    expect(input?.accept).toBe(AVATAR_ACCEPT);
    expect(form.querySelector(`label[for="${input?.id}"]`)?.textContent).toBe(translate(locale, "avatar"));
    expect(input?.getAttribute("aria-describedby")).toBe(form.querySelector('[role="status"]')?.id);
  });
});

describe("processed avatar preview", () => {
  it("previews and returns the exact processed image with dimensions and output size", async () => {
    const output = processed("klee.webp", "blob:exact-webp");
    const process = vi.fn(async () => output);
    const picker = avatarFilePicker(copy("en"), { process });
    document.body.append(picker);
    const input = picker.querySelector<HTMLInputElement>('input[name="avatar"]')!;
    const raw = new File(["raw jpeg"], "<b>klee.jpg</b>", { type: "image/jpeg" });

    choose(input, raw);
    expect(picker.querySelector('[role="status"]')?.textContent).toBe(copy("en").processing);
    expect(await picker.processedFile()).toBe(output.file);
    expect(process).toHaveBeenCalledWith(raw);
    expect(picker.querySelector<HTMLImageElement>("img")?.src).toBe("blob:exact-webp");
    expect(picker.querySelector<HTMLImageElement>("img")?.alt).toBe(copy("en").previewAlt);
    expect(picker.querySelector(".file-picker__metadata")?.textContent).toBe("900 × 900 px · 2.0 KiB");
    expect(picker.querySelector('[role="status"]')?.textContent).toBe(copy("en").ready);
    expect(picker.querySelector("b")).toBeNull();
  });

  it("disposes replacement and abort results, including a late stale decode", async () => {
    let resolveFirst!: (value: ProcessedAvatar) => void;
    const firstPromise = new Promise<ProcessedAvatar>((resolve) => { resolveFirst = resolve; });
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const process = vi.fn()
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(processed("second.webp", "blob:second", secondDispose));
    const controller = new AbortController();
    const picker = avatarFilePicker(copy("en"), { process, signal: controller.signal });
    const input = picker.querySelector<HTMLInputElement>("input")!;

    choose(input, new File(["first"], "first.png", { type: "image/png" }));
    const submittedFile = picker.processedFile();
    choose(input, new File(["second"], "second.png", { type: "image/png" }));
    resolveFirst(processed("first.webp", "blob:first", firstDispose));
    expect(await submittedFile).toMatchObject({ name: "second.webp" });
    await firstPromise;
    await Promise.resolve();
    expect(firstDispose).toHaveBeenCalledOnce();

    controller.abort();
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(picker.querySelector("img")?.hasAttribute("src")).toBe(false);
    picker.dispose();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it("reports processing failure and never falls back to the raw file", async () => {
    const picker = avatarFilePicker(copy("en"), { process: async () => { throw new Error("decode failed"); } });
    const input = picker.querySelector<HTMLInputElement>("input")!;
    choose(input, new File(["raw"], "raw.png", { type: "image/png" }));

    await expect(picker.processedFile()).resolves.toBeUndefined();
    expect(picker.querySelector('[role="status"]')?.textContent).toBe(copy("en").failed);
    expect(picker.querySelector("img")?.hidden).toBe(true);
  });
});
