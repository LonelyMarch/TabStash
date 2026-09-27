import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { type BrowserBrand, detectBrowser } from '../../src/domain/appearance';
import { effectiveLocale, type LanguageMode } from '../../src/i18n/core';
import { LanguageProvider } from '../../src/i18n/react';
import { AppearanceStore } from '../../src/infrastructure/storage/appearance';
import { LanguageStore } from '../../src/infrastructure/storage/language';
import App from './App';
import './styles/index.css';

/**
 * 先解析浏览器与外观，再挂载共用的 Side Panel 界面。
 *
 * @throws Error 当入口 HTML 缺少 root 容器时抛出，便于直接定位打包配置问题。
 */
async function mountSidePanel(): Promise<void> {
  const rootElement = document.getElementById('root');
  if (rootElement === null) {
    throw new Error('TabStash Side Panel 缺少 root 容器');
  }

  const hints = navigator as Navigator & { userAgentData?: { brands?: BrowserBrand[] } };
  document.documentElement.dataset.browser = detectBrowser(
    navigator.userAgent,
    hints.userAgentData?.brands,
  );
  document.documentElement.dataset.theme = 'auto';

  // 先读取独立外观键，再挂载界面；存储失效时最多等待 1 秒并保持自动模式。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('外观读取超时')), 1000);
    });
    const mode = await Promise.race([new AppearanceStore(browser.storage.local).get(), timeout]);
    document.documentElement.dataset.theme = mode;
  } catch (error: unknown) {
    console.warn('使用自动外观启动侧栏', error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // 语言设置与外观一样在首次渲染前读取，避免界面语言或文字方向短暂闪烁。
  let languageMode: LanguageMode = 'auto';
  let languageTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    languageMode = await Promise.race([
      new LanguageStore(browser.storage.local).get(),
      new Promise<never>((_, reject) => {
        languageTimer = setTimeout(() => reject(new Error('Language read timed out')), 1000);
      }),
    ]);
  } catch (error: unknown) {
    console.warn('Could not load language setting; using browser language', error);
  } finally {
    if (languageTimer !== undefined) clearTimeout(languageTimer);
  }
  const locale = effectiveLocale(languageMode, browser.i18n.getUILanguage());
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  createRoot(rootElement).render(
    <LanguageProvider initialMode={languageMode}>
      <App />
    </LanguageProvider>,
  );
}

void mountSidePanel();
