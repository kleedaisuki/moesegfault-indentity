// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { translate } from "../i18n";
import type { Locale } from "../i18n";
import { avatarFilePicker, AVATAR_ACCEPT } from "./file-picker";

const locales = ["zh-CN", "en", "ja"] as const satisfies readonly Locale[];

afterEach(() => document.body.replaceChildren());

describe.each(locales)("avatar file picker in %s", (locale) => {
  it("keeps an explicitly labelled native control in FormData", () => {
    const picker = avatarFilePicker({
      label: translate(locale, "avatar"),
      choose: translate(locale, "chooseAvatar"),
      empty: translate(locale, "noAvatarSelected"),
    });
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
    expect(new FormData(form).has("avatar")).toBe(true);
  });

  it("announces the localized empty state and selected filename as text", () => {
    const picker = avatarFilePicker({
      label: translate(locale, "avatar"),
      choose: translate(locale, "chooseAvatar"),
      empty: translate(locale, "noAvatarSelected"),
    });
    const form = document.createElement("form");
    form.append(picker);
    document.body.append(form);
    const input = picker.querySelector<HTMLInputElement>('input[name="avatar"]')!;
    const status = picker.querySelector<HTMLElement>('[role="status"]')!;

    expect(status.textContent).toBe(translate(locale, "noAvatarSelected"));
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.dir).toBe("auto");
    expect(input.getAttribute("aria-describedby")).toBe(status.id);

    const file = new File(["avatar"], '<b lang="en">klee.webp</b>', { type: "image/webp" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change"));

    expect(status.textContent).toBe(file.name);
    expect(status.querySelector("b")).toBeNull();
    expect((new FormData(form).get("avatar") as File).name).toBe(file.name);
  });
});
