import { en, type MessageKey, zhCN } from './messages';

/** 用户保存的语言模式；自动模式按浏览器界面语言解析。 */
export type LanguageMode = 'auto' | 'zh-CN' | 'en';
export type Locale = Exclude<LanguageMode, 'auto'>;

/** 持久诊断只保存稳定键及原始参数，不在数据库中保存某种语言的句子。 */
export interface Diagnostic {
  key: MessageKey;
  params?: Record<string, string | number>;
}

/** @param value 未经信任的存储值。@returns 是否为有效语言模式。 */
export function isLanguageMode(value: unknown): value is LanguageMode {
  return value === 'auto' || value === 'zh-CN' || value === 'en';
}

/**
 * 根据浏览器界面语言选择扩展支持的显示语言。
 *
 * 目前所有 `zh` 开头的浏览器语言都兼容到简体中文；其余未提供词条的
 * 语言统一回退 English，确保自动模式始终有明确的显示语言。
 *
 * @param browserLanguage 浏览器界面语言，例如 `en-US` 或 `zh-CN`。
 * @returns TabStash 对应的显示语言。
 */
export function resolveLocale(browserLanguage: string): Locale {
  const normalized = browserLanguage.trim().toLowerCase();
  return normalized.startsWith('zh') ? 'zh-CN' : 'en';
}

/** @param mode 用户选择。@param browserLanguage 浏览器界面语言。@returns 实际显示语言。 */
export function effectiveLocale(mode: LanguageMode, browserLanguage: string): Locale {
  return mode === 'auto' ? resolveLocale(browserLanguage) : mode;
}

/**
 * 从词条键与命名参数生成当前语言的文本。
 * @param locale 实际显示语言。
 * @param key 中英文词条共用的稳定键。
 * @param params 数量、标题等不参与翻译的参数。
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const template = locale === 'zh-CN' ? zhCN[key] : en[key];
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
