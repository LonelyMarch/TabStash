import { ar } from './locales/ar';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { ru } from './locales/ru';
import { en, type MessageKey, zhCN } from './messages';

/** 用户保存的语言模式；自动模式按浏览器界面语言解析。 */
export const locales = ['zh-CN', 'en', 'ar', 'fr', 'ru', 'es'] as const;
export type Locale = (typeof locales)[number];
export type LanguageMode = 'auto' | Locale;

/** 语言菜单使用各语言的自称，切换界面语言后仍能识别选项。 */
export const languageNames: Record<Locale, string> = {
  'zh-CN': '简体中文',
  en: 'English',
  ar: 'العربية',
  fr: 'Français',
  ru: 'Русский',
  es: 'Español',
};

/** 各语言共用稳定词条键，类型检查会阻止缺失的翻译进入构建。 */
const messages: Record<Locale, Record<MessageKey, string>> = { 'zh-CN': zhCN, en, ar, fr, ru, es };

/** 持久诊断只保存稳定键及原始参数，不在数据库中保存某种语言的句子。 */
export interface Diagnostic {
  key: MessageKey;
  params?: Record<string, string | number>;
}

/** @param value 未经信任的存储值。@returns 是否为有效语言模式。 */
export function isLanguageMode(value: unknown): value is LanguageMode {
  return value === 'auto' || locales.some((locale) => locale === value);
}

/**
 * 根据浏览器界面语言选择扩展支持的显示语言。
 *
 * 所有 `zh` 开头的浏览器语言兼容到简体中文；其余按主语言代码匹配，
 * 未提供词条的语言回退英语，确保自动模式始终有明确的显示语言。
 *
 * @param browserLanguage 浏览器界面语言，例如 `en-US` 或 `zh-CN`。
 * @returns TabStash 对应的显示语言。
 */
export function resolveLocale(browserLanguage: string): Locale {
  const primary = browserLanguage.trim().toLowerCase().split(/[-_]/)[0];
  if (primary === 'zh') return 'zh-CN';
  return locales.find((locale) => locale === primary) ?? 'en';
}

/** @param mode 用户选择。@param browserLanguage 浏览器界面语言。@returns 实际显示语言。 */
export function effectiveLocale(mode: LanguageMode, browserLanguage: string): Locale {
  return mode === 'auto' ? resolveLocale(browserLanguage) : mode;
}

/**
 * 从词条键与命名参数生成当前语言的文本。
 * @param locale 实际显示语言。
 * @param key 所有语言词条共用的稳定键。
 * @param params 数量、标题等不参与翻译的参数。
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const template = messages[locale][key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

/** @param locale 实际显示语言。@param diagnostic 持久或实时诊断。@returns 本地化说明。 */
export function translateDiagnostic(locale: Locale, diagnostic: Diagnostic): string {
  return translate(locale, diagnostic.key, diagnostic.params);
}

/** 保留已知应用诊断；浏览器异常只记入日志并转为当前操作的稳定故障代码。 */
export function diagnosticFromError(error: unknown, fallback: Diagnostic['key']): Diagnostic {
  if (error && typeof error === 'object' && 'diagnostic' in error) {
    const value = error.diagnostic;
    if (
      value &&
      typeof value === 'object' &&
      'key' in value &&
      typeof value.key === 'string' &&
      value.key in zhCN
    )
      return value as Diagnostic;
  }
  console.error('TabStash operation failed', error);
  return { key: fallback };
}

/** 只显示应用已知的错误代码；外部浏览器错误保留在开发者工具，不注入界面文案。 */
export class AppError extends Error {
  constructor(public readonly diagnostic: Diagnostic) {
    super(diagnostic.key);
    this.name = 'AppError';
  }
}

/** @param locale 当前语言。@param error 浏览器或扩展错误。@returns 面向用户的说明。 */
export function describeError(locale: Locale, error: unknown): string {
  return translateDiagnostic(locale, diagnosticFromError(error, 'unknownError'));
}
