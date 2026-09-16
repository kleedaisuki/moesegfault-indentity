import { LOCALES, type Locale } from "@moesegfault/frontend-shared";
import { el } from "./dom";

/**
 * 创建共享自称语言选项，并用 `lang` 让辅助技术正确发音。
 * Creates shared autonym locale options and marks each language for assistive pronunciation.
 */
export function localeOptions(selected: Locale): HTMLOptionElement[] {
  return LOCALES.map(({ tag, autonym, htmlLang }) => el("option", { attrs: { value: tag, lang: htmlLang, selected: tag === selected } }, autonym));
}
