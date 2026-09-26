import { Globe2 } from 'lucide-react';
import { useState } from 'react';
import { browser } from 'wxt/browser';
import { isNewTabPage, newTabIconVariant } from '../domain/window/new-tab-icon';

/**
 * 为浏览器原生 favicon 服务构造扩展内地址。
 *
 * @param pageUrl 标签页的实际 URL，可为 Edge/Chrome 内置页或普通网页。
 * @returns 浏览器从自身图标缓存读取该页面图标的扩展 URL。
 */
function browserFaviconUrl(pageUrl: string): string {
  const favicon = new URL('/_favicon/', browser.runtime.getURL('/sidepanel.html'));
  favicon.searchParams.set('pageUrl', pageUrl);
  // 16 CSS 像素至少读取 32 像素图源；高 DPI 屏幕读取 64 像素以避免放大模糊。
  favicon.searchParams.set('size', window.devicePixelRatio > 2 ? '64' : '32');
  return favicon.toString();
}

/**
 * 判断浏览器内置页的 favicon 是否需要在浅色侧栏中转换为深色。
 *
 * 浏览器的 favicon 服务会为多数内置页返回白色线条图标；历史记录页使用蓝色图标，
 * 应保留原色。普通网站和扩展页的图标也不得受到转换影响。
 *
 * @param pageUrl 标签页地址；归档中的旧记录可能没有有效地址。
 * @returns 仅对白色线条的浏览器内置页及 about 页面返回 true。
 */
function shouldTintBrowserPageIcon(pageUrl: string | null): boolean {
  if (pageUrl === null) return false;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol === 'about:') return true;
    return (
      (parsed.protocol === 'edge:' || parsed.protocol === 'chrome:') &&
      parsed.hostname !== 'history'
    );
  } catch {
    return false;
  }
}

/**
 * 实时标签与归档标签共用的图标展示，确保同一页面在两棵树中外观一致。
 *
 * @param props.url 页面地址；浏览器内置页通常只通过此字段提供图标线索。
 * @param props.title 标签标题，用于识别扩展接管的新标签页。
 * @param props.favIconUrl 保存或读取到的 favicon URL，空值视为缺失。
 * @returns 浏览器当前配置对应的图标，查询失败时显示通用图标。
 */
export function TabIcon({
  url,
  title,
  favIconUrl,
}: {
  url: string | null;
  title: string;
  favIconUrl: string | null;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  if (isNewTabPage(url, title)) {
    const variant = newTabIconVariant(navigator.userAgent);
    const asset = variant === 'edge' ? 'newtab-edge.svg' : 'newtab-chromium.png';
    const iconUrl = new URL(
      `/icons/browser/${asset}`,
      browser.runtime.getURL('/sidepanel.html'),
    ).toString();
    const maskImage = `url("${iconUrl}")`;
    return (
      <span
        aria-hidden="true"
        className={`browser-newtab-icon ${variant}`}
        data-browser-icon={`newtab-${variant}`}
        style={{ maskImage, WebkitMaskImage: maskImage }}
      />
    );
  }

  const directIcon = favIconUrl?.trim() || null;
  const pageUrl = url?.trim() || null;
  const browserIcon = pageUrl === null ? null : browserFaviconUrl(pageUrl);
  // Edge/Chrome 内置页常返回空字符串；普通网站图标失效时也可回退到浏览器缓存。
  const sources = [directIcon, browserIcon].filter(
    (source, index, values): source is string =>
      source !== null && values.indexOf(source) === index,
  );
  const iconUrl = sources[sourceIndex];

  if (iconUrl === undefined) {
    return <Globe2 aria-hidden="true" className="tab-icon" size={15} />;
  }

  return (
    <img
      alt=""
      className={`tab-icon${shouldTintBrowserPageIcon(pageUrl) ? ' browser-page-icon' : ''}`}
      onError={() => setSourceIndex((current) => current + 1)}
      referrerPolicy="no-referrer"
      src={iconUrl}
    />
  );
}
