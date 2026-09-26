import { detectBrowser } from '../appearance';

/** 浏览器自带的新建标签页图标种类。 */
export type NewTabIconVariant = 'edge' | 'chromium';

/**
 * 判断标签是否是浏览器新建标签页，包括扩展接管后的扩展页面。
 *
 * @param url 浏览器报告的标签地址。
 * @param title 浏览器报告的标签标题。
 * @returns 应使用浏览器原生新标签页图标时返回 true。
 */
export function isNewTabPage(url: string | null, title: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol === 'edge:' && parsed.hostname === 'newtab') return true;
  if (
    parsed.protocol === 'chrome:' &&
    (parsed.hostname === 'newtab' || parsed.hostname === 'new-tab-page')
  )
    return true;
  if (parsed.protocol === 'about:' && parsed.pathname === 'newtab') return true;
  if (parsed.protocol !== 'chrome-extension:' && parsed.protocol !== 'extension:') return false;

  // 接管新标签页的扩展可使用任意入口名；标题或路径任一线索命中即可识别。
  return (
    /^(?:新标签页|新建标签页|新分頁|new tab|new tab page)$/i.test(title.trim()) ||
    /(?:^|\/)(?:new[-_]?tab|newtabpage)(?:[/.]|$)/i.test(parsed.pathname)
  );
}

/**
 * 根据运行浏览器选择新标签页图标，避免将 Edge 的样式用于 Chrome。
 *
 * @param userAgent 当前扩展页面的浏览器 User-Agent。
 * @returns Edge 使用 Fluent 页签图标，其余 Chromium 浏览器使用 Chromium 页签图标。
 */
export function newTabIconVariant(userAgent: string): NewTabIconVariant {
  return detectBrowser(userAgent) === 'edge' ? 'edge' : 'chromium';
}
