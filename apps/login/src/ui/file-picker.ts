import { el } from "./dom";

/** 浏览器可识别的头像格式提示，同时保留扩展名以兼容缺少 MIME 类型的文件。Browser-recognized avatar format hints, including extensions for files without a MIME type. */
export const AVATAR_ACCEPT = "image/avif,.avif,image/png,.png,image/jpeg,.jpg,.jpeg,image/webp,.webp";

let nextPickerId = 0;

/** 文件选择器的本地化可见文本。Localized visible copy for the file picker. */
export interface FilePickerCopy {
  label: string;
  choose: string;
  empty: string;
}

/**
 * 创建保留原生文件控件语义的头像选择器。Creates an avatar picker that preserves native file-control semantics.
 *
 * 输入框只做视觉隐藏而不从可访问性树移除；它仍参与键盘导航和 `FormData`，
 * 焦点则投射到可见触发器。The input is visually hidden rather than removed from the
 * accessibility tree; it remains keyboard- and `FormData`-operable while focus is
 * projected onto the visible trigger.
 */
export function avatarFilePicker(copy: FilePickerCopy): HTMLElement {
  const inputId = `avatar-picker-${++nextPickerId}`;
  const statusId = `${inputId}-status`;
  const status = el("span", {
    className: "file-picker__status",
    attrs: { id: statusId, role: "status", "aria-live": "polite", dir: "auto" },
  }, copy.empty);
  const input = el("input", {
    className: "visually-hidden file-picker__input",
    attrs: {
      id: inputId,
      name: "avatar",
      type: "file",
      accept: AVATAR_ACCEPT,
      "aria-describedby": statusId,
    },
  });

  input.addEventListener("change", () => {
    // textContent 把来自本地文件系统的名称当作纯文本。textContent treats local filenames as plain text.
    status.textContent = input.files?.[0]?.name ?? copy.empty;
  });

  return el("div", { className: "field file-picker" },
    el("label", { className: "field__label", attrs: { for: inputId } }, copy.label),
    el("div", { className: "file-picker__control" },
      input,
      el("label", { className: "file-picker__button", attrs: { for: inputId } }, copy.choose),
      status,
    ),
  );
}
