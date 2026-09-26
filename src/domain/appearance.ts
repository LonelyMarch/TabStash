/** TabStash 支持的两套浏览器外观。其他 Chromium 浏览器沿用 Chrome 风格。 */
export type BrowserKind = 'edge' | 'chrome';

/** 用户可保存的外观模式；自动模式由 CSS 跟随系统配色。 */
export type AppearanceMode = 'auto' | 'light' | 'dark';

/** User-Agent Client Hints 中公开的浏览器品牌字段。 */
export interface BrowserBrand {
  brand: string;
}

/**
 * 集中判断当前浏览器，保证界面与新标签页图标选用同一品牌。
 *
 * @param userAgent 浏览器 User-Agent，供 Client Hints 不可用时兜底。
 * @param brands 可选的 User-Agent Client Hints 品牌列表。
 * @returns Edge 或 Chrome 风格；未知 Chromium 浏览器使用 Chrome 风格。
 */
export function detectBrowser(userAgent: string, brands?: readonly BrowserBrand[]): BrowserKind {
  if (brands?.some((entry) => entry.brand === 'Microsoft Edge')) return 'edge';
  return /\bEdg(?:A|iOS)?\//.test(userAgent) ? 'edge' : 'chrome';
}

/** @param value 未经信任的存储或消息值。@returns 是否为有效的外观模式。 */
export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === 'auto' || value === 'light' || value === 'dark';
}
