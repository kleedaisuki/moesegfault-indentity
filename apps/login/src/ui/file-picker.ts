import { processAvatarImage } from "@moesegfault/frontend-shared";
import type { ProcessedAvatar } from "@moesegfault/frontend-shared";
import { el } from "./dom";

/** 浏览器可识别的头像格式提示，同时保留扩展名以兼容缺少 MIME 类型的文件。Browser-recognized avatar format hints, including extensions for files without a MIME type. */
export const AVATAR_ACCEPT = "image/avif,.avif,image/png,.png,image/jpeg,.jpg,.jpeg,image/webp,.webp";

let nextPickerId = 0;

/** 文件选择器的本地化可见文本。Localized visible copy for the file picker. */
export interface FilePickerCopy {
  label: string;
  choose: string;
  empty: string;
  processing: string;
  ready: string;
  failed: string;
  previewAlt: string;
}

/** 可注入的头像处理函数，供界面测试使用。Injectable avatar processor for UI tests. */
export type AvatarProcessor = (file: File) => Promise<ProcessedAvatar>;

/** 拥有处理结果及其对象 URL 生命周期的头像选择器。Avatar picker that owns the processed result and its object-URL lifecycle. */
export interface AvatarFilePicker extends HTMLElement {
  /** 等待当前选择完成处理，并返回可上传图片；失败或未选择时返回 undefined。Waits for the current selection and returns its uploadable processed image, or undefined. */
  processedFile(): Promise<File | undefined>;
  /** 锁定或解锁选择，确保预览与即将上传的文件一致。Locks or unlocks selection so preview and upload stay identical. */
  setDisabled(disabled: boolean): void;
  /** 释放预览；可重复调用。Releases the preview and is safe to call repeatedly. */
  dispose(): void;
}

/** 头像选择器的生命周期与测试选项。Lifecycle and test options for the avatar picker. */
export interface AvatarFilePickerOptions {
  /** 页面生命周期；中止时立即释放预览。Page lifetime; aborting immediately releases the preview. */
  signal?: AbortSignal;
  /** 测试替身；生产环境使用共享处理管线。Test seam; production uses the shared pipeline. */
  process?: AvatarProcessor;
}

/**
 * 创建会在上传前生成并预览实际输出图片的头像选择器。
 * Creates an avatar picker that generates and previews the exact output image before upload.
 * 输出优先使用 WebP，不支持 WebP 编码的平台按 Canvas 标准使用 PNG。
 * Output prefers WebP and uses the Canvas-standard PNG fallback when WebP encoding is unavailable.
 *
 * 原生 input 仍可聚焦且保留文件选择语义，但调用者必须上传 `processedFile()`，
 * 而不是 FormData 中未经处理的原文件。The native input remains focusable and keeps
 * file-selection semantics, but callers must upload `processedFile()` rather than the
 * unprocessed file present in FormData.
 */
export function avatarFilePicker(copy: FilePickerCopy, options: AvatarFilePickerOptions = {}): AvatarFilePicker {
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
  const preview = el("img", {
    className: "file-picker__preview",
    attrs: { alt: copy.previewAlt, hidden: true },
  });
  const metadata = el("span", { className: "file-picker__metadata", attrs: { hidden: true } });
  const root = el("div", { className: "field file-picker" },
    el("label", { className: "field__label", attrs: { for: inputId } }, copy.label),
    el("div", { className: "file-picker__body" },
      preview,
      el("div", { className: "file-picker__details" },
        el("div", { className: "file-picker__control" },
          input,
          el("label", { className: "file-picker__button", attrs: { for: inputId } }, copy.choose),
          status,
        ),
        metadata,
      ),
    ),
  ) as unknown as AvatarFilePicker;

  const processor = options.process ?? processAvatarImage;
  let prepared: ProcessedAvatar | undefined;
  let pending: Promise<void> = Promise.resolve();
  let generation = 0;
  let disposed = false;

  const clearPrepared = (): void => {
    prepared?.dispose();
    prepared = undefined;
    preview.removeAttribute("src");
    preview.hidden = true;
    metadata.hidden = true;
    metadata.textContent = "";
  };

  const onChange = (): void => {
    const selected = input.files?.[0];
    const selectedGeneration = ++generation;
    clearPrepared();
    if (!selected) {
      status.textContent = copy.empty;
      pending = Promise.resolve();
      return;
    }

    status.textContent = copy.processing;
    pending = processor(selected).then((result) => {
      if (disposed || selectedGeneration !== generation) {
        result.dispose();
        return;
      }
      prepared = result;
      preview.src = result.previewUrl;
      preview.hidden = false;
      metadata.textContent = `${result.metadata.edge} × ${result.metadata.edge} px · ${formatBytes(result.metadata.outputBytes)}`;
      metadata.hidden = false;
      status.textContent = copy.ready;
    }).catch(() => {
      if (!disposed && selectedGeneration === generation) status.textContent = copy.failed;
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    clearPrepared();
    input.removeEventListener("change", onChange);
    options.signal?.removeEventListener("abort", dispose);
  };

  input.addEventListener("change", onChange);
  options.signal?.addEventListener("abort", dispose, { once: true });
  if (options.signal?.aborted) dispose();
  root.processedFile = async () => {
    // 选择可能在一次解码等待期间被替换；总是等待最新一代。
    // Selection may change while one decode is pending; always await the newest generation.
    let observed: Promise<void>;
    do {
      observed = pending;
      await observed;
    } while (observed !== pending);
    return prepared?.file;
  };
  root.setDisabled = (disabled) => { input.disabled = disabled; };
  root.dispose = dispose;
  return root;
}

/** 以紧凑的二进制单位展示上传体积。Formats an upload size with compact binary units. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
