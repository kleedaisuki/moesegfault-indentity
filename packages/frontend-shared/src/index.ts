/**
 * 前端共享的区域设置元数据。
 * Shared locale metadata for the browser applications.
 */
export const LOCALES = [
  { tag: "zh-CN", autonym: "简体中文", htmlLang: "zh-CN" },
  { tag: "en", autonym: "English", htmlLang: "en" },
  { tag: "ja", autonym: "日本語", htmlLang: "ja" },
] as const satisfies readonly {
  readonly tag: string;
  readonly autonym: string;
  readonly htmlLang: string;
}[];

/** 产品支持的区域设置标签。Locale tags supported by the product. */
export type Locale = (typeof LOCALES)[number]["tag"];

const localeTags: ReadonlySet<string> = new Set(LOCALES.map(({ tag }) => tag));

/**
 * 判断一个未知值是否为受支持的区域设置标签。
 * Determines whether an unknown value is a supported locale tag.
 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && localeTags.has(value);
}

/**
 * 将浏览器或持久化的语言标签规整为产品支持的区域设置。
 * Normalizes a browser or persisted language tag to a supported locale.
 *
 * 未知、空白或缺失的值使用简体中文作为产品默认值。地区变体按其主要语言匹配，
 * 因而 `en-US` 和 `ja-JP` 分别映射到 `en` 和 `ja`。
 * Unknown, blank, or absent values use Simplified Chinese as the product default.
 * Regional variants are matched by primary language, so `en-US` and `ja-JP` map
 * to `en` and `ja`, respectively.
 *
 * @example
 * ```ts
 * normalizeLocale("en-GB"); // "en"
 * normalizeLocale("zh-TW"); // "zh-CN"
 * ```
 */
export function normalizeLocale(value: string | null | undefined): Locale {
  const primaryLanguage = value?.trim().split(/[-_]/, 1)[0]?.toLowerCase();

  switch (primaryLanguage) {
    case "en":
      return "en";
    case "ja":
      return "ja";
    default:
      return "zh-CN";
  }
}
