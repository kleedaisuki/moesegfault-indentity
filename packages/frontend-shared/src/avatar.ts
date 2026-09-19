/** 头像输入的最大字节数（10 MiB）。Maximum avatar input size in bytes (10 MiB). */
export const AVATAR_MAX_INPUT_BYTES = 10 * 1024 * 1024;

/** 头像输出的默认最大边长。Default maximum avatar output edge. */
export const AVATAR_DEFAULT_MAX_EDGE = 1024;

/** WebP 输出的默认有损质量。Default lossy WebP output quality. */
export const AVATAR_DEFAULT_WEBP_QUALITY = 0.86;

/** 浏览器头像管线接受的 MIME 类型。MIME types accepted by the browser avatar pipeline. */
export const AVATAR_INPUT_TYPES = ["image/avif", "image/jpeg", "image/png", "image/webp"] as const;

/** 头像输入 MIME 类型。Accepted avatar input MIME type. */
export type AvatarInputType = (typeof AVATAR_INPUT_TYPES)[number];

/** 浏览器头像管线可能产生的安全输出类型。Safe output types produced by the browser avatar pipeline. */
export type AvatarOutputType = "image/webp" | "image/png";

/** 可供界面稳定映射的头像处理错误码。Stable avatar-processing error codes for UI mapping. */
export type AvatarImageErrorCode =
  | "INVALID_INPUT"
  | "EMPTY_INPUT"
  | "INPUT_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "INVALID_DIMENSIONS"
  | "DECODE_FAILED"
  | "ENCODE_FAILED"
  | "UNSUPPORTED_BROWSER";

/**
 * 带稳定错误码的头像处理异常。Avatar-processing error carrying a stable error code.
 */
export class AvatarImageError extends Error {
  /** 程序可判断的失败类别。Machine-readable failure category. */
  public readonly code: AvatarImageErrorCode;

  /** 构造头像处理异常。Constructs an avatar-processing error. */
  public constructor(code: AvatarImageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AvatarImageError";
    this.code = code;
  }
}

/** 中心正方形裁剪与缩放的纯几何计划。Pure geometry plan for centered square crop and resize. */
export interface AvatarTransformPlan {
  /** 源图上的裁剪起点。Crop origin on the source image. */
  readonly sourceX: number;
  /** 源图上的裁剪起点。Crop origin on the source image. */
  readonly sourceY: number;
  /** 正方形源裁剪边长。Square source crop edge. */
  readonly sourceEdge: number;
  /** 正方形输出边长。Square output edge. */
  readonly outputEdge: number;
}

/**
 * 为已按 EXIF 方向解码的图片计算中心正方形裁剪，且绝不放大。
 * Plans a centered square crop for an EXIF-oriented image without ever upscaling.
 *
 * @example
 * ```ts
 * planAvatarTransform(1600, 900); // sourceX=350, sourceY=0, outputEdge=900
 * ```
 */
export function planAvatarTransform(
  width: number,
  height: number,
  maxEdge: number = AVATAR_DEFAULT_MAX_EDGE,
): AvatarTransformPlan {
  if (
    !isPositiveInteger(width)
    || !isPositiveInteger(height)
    || !isPositiveInteger(maxEdge)
    || maxEdge > AVATAR_DEFAULT_MAX_EDGE
  ) {
    throw new AvatarImageError(
      "INVALID_DIMENSIONS",
      "Avatar dimensions and maximum edge must be positive integers",
    );
  }

  const sourceEdge = Math.min(width, height);
  return {
    sourceX: Math.floor((width - sourceEdge) / 2),
    sourceY: Math.floor((height - sourceEdge) / 2),
    sourceEdge,
    outputEdge: Math.min(sourceEdge, maxEdge),
  };
}

/** 由平台解码器拥有、调用方最终关闭的图像。Decoded image owned by the platform and eventually closed by the caller. */
export interface AvatarDecodedImage {
  /** 已应用方向后的像素宽度。Pixel width after orientation is applied. */
  readonly width: number;
  /** 已应用方向后的像素高度。Pixel height after orientation is applied. */
  readonly height: number;
  /** 平台渲染器理解的非透明源句柄。Opaque source handle understood by the platform renderer. */
  readonly source: unknown;
  /** 释放底层解码像素。Releases the underlying decoded pixels. */
  close(): void;
}

/**
 * 浏览器能力边界；注入它可在无真实 Canvas 的测试中验证控制流。
 * Browser capability boundary; inject it to test control flow without a real canvas.
 */
export interface AvatarImagePlatform {
  /** 解码并应用图片方向元数据。Decodes and applies image-orientation metadata. */
  decode(blob: Blob): Promise<AvatarDecodedImage>;
  /** 高质量渲染并优先编码 WebP；平台可按标准回退 PNG。Renders at high quality, preferring WebP with the standards-defined PNG fallback. */
  render(image: AvatarDecodedImage, plan: AvatarTransformPlan, webpQuality: number): Promise<Blob>;
  /** 为预览创建调用方拥有的对象 URL。Creates a caller-owned object URL for preview. */
  createObjectURL(blob: Blob): string;
  /** 释放此前创建的对象 URL。Releases a previously created object URL. */
  revokeObjectURL(url: string): void;
}

/** 头像处理选项。Avatar processing options. */
export interface ProcessAvatarImageOptions {
  /** 输出文件名；缺省从输入文件名派生。Output filename; derived from the input filename by default. */
  readonly fileName?: string;
  /** 最大输出边长，范围 1–1024，默认 1024。Maximum output edge from 1–1024, 1024 by default. */
  readonly maxEdge?: number;
  /** WebP 编码质量（0 到 1），默认 0.86；PNG 回退忽略此值。WebP quality from 0 to 1, 0.86 by default; ignored by PNG fallback. */
  readonly quality?: number;
  /** 可替换的平台适配器，主要用于确定性测试。Replaceable platform adapter, primarily for deterministic tests. */
  readonly platform?: AvatarImagePlatform;
}

/** 已处理头像的可观察元数据。Observable metadata for a processed avatar. */
export interface ProcessedAvatarMetadata {
  /** 原始文件字节数。Original byte size. */
  readonly inputBytes: number;
  /** 输出文件字节数。Output byte size. */
  readonly outputBytes: number;
  /** 已应用 EXIF 方向后的原始宽度。Original width after EXIF orientation. */
  readonly sourceWidth: number;
  /** 已应用 EXIF 方向后的原始高度。Original height after EXIF orientation. */
  readonly sourceHeight: number;
  /** 正方形输出宽高。Square output width and height. */
  readonly edge: number;
  /** 实际输出媒体类型；与 `file.type` 一致。Actual output media type, identical to `file.type`. */
  readonly mediaType: AvatarOutputType;
}

/**
 * 处理后的上传文件和显式拥有的预览 URL。
 * Processed upload file and explicitly owned preview URL.
 *
 * `dispose()` 可重复调用；界面替换预览或卸载时必须调用它。
 * `dispose()` is idempotent and must be called when the UI replaces or unmounts the preview.
 */
export interface ProcessedAvatar {
  /** 可直接加入 FormData 的 WebP 或 PNG 文件。WebP or PNG file ready to append to FormData. */
  readonly file: File;
  /** 与 `file` 相同的 Blob 视图，便于非表单消费者。Blob view identical to `file` for non-form consumers. */
  readonly blob: Blob;
  /** 可赋给图片 `src` 的对象 URL。Object URL suitable for an image `src`. */
  readonly previewUrl: string;
  /** 处理结果元数据。Processing-result metadata. */
  readonly metadata: ProcessedAvatarMetadata;
  /** 仅一次释放预览 URL。Releases the preview URL exactly once. */
  dispose(): void;
}

/**
 * 验证、定向、中心裁剪、压缩头像，并返回上传文件和本地预览。
 * Validates, orients, center-crops, compresses an avatar and returns an upload file plus local preview.
 */
export async function processAvatarImage(
  input: Blob,
  options: ProcessAvatarImageOptions = {},
): Promise<ProcessedAvatar> {
  validateAvatarInput(input);
  const quality = options.quality ?? AVATAR_DEFAULT_WEBP_QUALITY;
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new AvatarImageError("INVALID_INPUT", "WebP quality must be a finite number from 0 to 1");
  }

  const maxEdge = options.maxEdge ?? AVATAR_DEFAULT_MAX_EDGE;
  if (!isPositiveInteger(maxEdge) || maxEdge > AVATAR_DEFAULT_MAX_EDGE) {
    throw new AvatarImageError("INVALID_INPUT", "Avatar maximum edge must be an integer from 1 to 1024");
  }
  const platform = options.platform ?? browserAvatarImagePlatform;
  let decoded: AvatarDecodedImage;
  try {
    decoded = await platform.decode(input);
  } catch (error) {
    if (error instanceof AvatarImageError) throw error;
    throw new AvatarImageError("DECODE_FAILED", "The avatar image could not be decoded", { cause: error });
  }

  try {
    const plan = planAvatarTransform(decoded.width, decoded.height, maxEdge);
    let encoded: Blob;
    try {
      encoded = await platform.render(decoded, plan, quality);
    } catch (error) {
      if (error instanceof AvatarImageError) throw error;
      throw new AvatarImageError("ENCODE_FAILED", "The avatar image could not be encoded", { cause: error });
    }
    const mediaType = encoded.type.toLowerCase();
    if (!isAvatarOutputType(mediaType)) {
      throw new AvatarImageError("ENCODE_FAILED", "This browser produced neither WebP nor PNG image data");
    }

    const file = new File([encoded], outputFileName(input, options.fileName, mediaType), {
      type: mediaType,
      lastModified: Date.now(),
    });
    const previewUrl = platform.createObjectURL(file);
    let disposed = false;

    return {
      file,
      blob: file,
      previewUrl,
      metadata: {
        inputBytes: input.size,
        outputBytes: file.size,
        sourceWidth: decoded.width,
        sourceHeight: decoded.height,
        edge: plan.outputEdge,
        mediaType,
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        platform.revokeObjectURL(previewUrl);
      },
    };
  } finally {
    // 释放解码缓冲区不应把成功结果变成失败，否则已创建的预览 URL 将无法交给调用方释放。
    // Releasing decoded pixels must not turn success into failure, or an already-created preview URL would leak.
    try {
      decoded.close();
    } catch {
      // ImageBitmap.close() 按规范不抛异常；自定义适配器也不得破坏所有权交接。
      // ImageBitmap.close() is non-throwing by contract; custom adapters must not break ownership transfer.
    }
  }
}

/** 使用现代浏览器原生 API 的生产适配器。Production adapter backed by modern browser-native APIs. */
export const browserAvatarImagePlatform: AvatarImagePlatform = {
  async decode(blob: Blob): Promise<AvatarDecodedImage> {
    if (typeof globalThis.createImageBitmap !== "function") {
      throw new AvatarImageError("UNSUPPORTED_BROWSER", "This browser cannot decode oriented images");
    }
    // `from-image` 按 HTML 标准应用 EXIF 方向，避免自行维护脆弱的 JPEG 解析器。
    // Per HTML, `from-image` applies EXIF orientation and avoids a fragile home-grown JPEG parser.
    const bitmap = await globalThis.createImageBitmap(blob, { imageOrientation: "from-image" });
    return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
  },

  async render(image: AvatarDecodedImage, plan: AvatarTransformPlan, quality: number): Promise<Blob> {
    const canvas = createSquareCanvas(plan.outputEdge);
    const context = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!context) throw new AvatarImageError("UNSUPPORTED_BROWSER", "A 2D canvas context is unavailable");

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image.source as CanvasImageSource,
      plan.sourceX,
      plan.sourceY,
      plan.sourceEdge,
      plan.sourceEdge,
      0,
      0,
      plan.outputEdge,
      plan.outputEdge,
    );

    if ("convertToBlob" in canvas) {
      return canvas.convertToBlob({ type: "image/webp", quality });
    }
    return canvasToBlob(canvas, quality);
  },

  createObjectURL(blob: Blob): string {
    return URL.createObjectURL(blob);
  },

  revokeObjectURL(url: string): void {
    URL.revokeObjectURL(url);
  },
};

/** 验证用户可控的 Blob 元数据。Validates user-controlled Blob metadata. */
function validateAvatarInput(input: Blob): asserts input is Blob {
  if (!input || typeof input.size !== "number" || typeof input.type !== "string") {
    throw new AvatarImageError("INVALID_INPUT", "Avatar input must be a Blob or File");
  }
  if (input.size === 0) throw new AvatarImageError("EMPTY_INPUT", "Avatar input must not be empty");
  if (input.size > AVATAR_MAX_INPUT_BYTES) {
    throw new AvatarImageError("INPUT_TOO_LARGE", "Avatar input must be at most 10 MiB");
  }
  if (!(AVATAR_INPUT_TYPES as readonly string[]).includes(input.type.toLowerCase())) {
    throw new AvatarImageError("UNSUPPORTED_TYPE", "Avatar input must be AVIF, JPEG, PNG, or WebP");
  }
}

/** 创建工作线程或主线程 Canvas。Creates a worker- or main-thread canvas. */
function createSquareCanvas(edge: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof globalThis.OffscreenCanvas === "function") return new OffscreenCanvas(edge, edge);
  if (typeof globalThis.document === "undefined") {
    throw new AvatarImageError("UNSUPPORTED_BROWSER", "Canvas is unavailable in this environment");
  }
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  return canvas;
}

/** 将回调式 HTML Canvas 编码包装为 Promise。Wraps callback-based HTML canvas encoding in a Promise. */
function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new AvatarImageError("ENCODE_FAILED", "Canvas returned no processed image data"));
    }, "image/webp", quality);
  });
}

/** 输出与实际编码一致、无重复扩展名的文件名。Produces a filename matching the actual encoding without duplicate extensions. */
function outputFileName(input: Blob, requested: string | undefined, mediaType: AvatarOutputType): string {
  const inputName = input instanceof File ? input.name : "avatar";
  const base = (requested ?? inputName).trim().replace(/\.[^.]*$/, "").trim();
  return `${base || "avatar"}.${mediaType === "image/webp" ? "webp" : "png"}`;
}

/** 将浏览器返回的 MIME 缩窄为受支持输出。Narrows a browser-returned MIME type to a supported output. */
function isAvatarOutputType(value: string): value is AvatarOutputType {
  return value === "image/webp" || value === "image/png";
}

/** 判断有限正整数。Checks for a finite positive integer. */
function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
