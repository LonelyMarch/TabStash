import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, expect, test } from '@playwright/test';
import type { browser } from 'wxt/browser';

declare const chrome: typeof browser;

/** 在隔离 Edge 中验证内部页高清图标与扩展接管新标签页的图标选择。 */
// biome-ignore lint/correctness/noEmptyPattern: Playwright 测试夹具要求解构参数，本用例自行启动隔离 Edge。
test('Edge 内部页面显示浏览器图标', async ({}) => {
  const profile = await mkdtemp(join(tmpdir(), 'tabstash-icon-check-'));
  const extensionPath = resolve('.output/edge-mv3');
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge',
      headless: false,
      // 固定测试界面语言，确保下方的中文外观菜单断言不依赖 CI 浏览器默认语言。
      locale: 'zh-CN',
      viewport: { width: 390, height: 844 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    const created = await page.evaluate(async () => {
      const urls = [
        undefined,
        'edge://extensions/',
        'edge://settings/',
        'edge://downloads/',
        'edge://history/',
        'edge://favorites/',
        'edge://apps/',
      ];
      const ids: number[] = [];
      for (const url of urls) {
        const tab = await chrome.tabs.create(url === undefined ? {} : { url });
        if (tab.id === undefined) throw new Error(`内部页缺少标签 ID：${url}`);
        ids.push(tab.id);
      }
      return ids;
    });
    const newTabRow = page.locator(`[data-tree-node="tab-${created[0]}"]`);
    const newTabIcon = newTabRow.locator('[data-browser-icon="newtab-edge"]');
    await expect(newTabIcon).toBeVisible();
    await expect(newTabIcon).toHaveCSS('mask-image', /newtab-edge\.svg/);

    for (const [index, id] of created.entries()) {
      if (index === 0) continue;
      const tabRow = page.locator(`[data-tree-node="tab-${id}"]`);
      await expect(tabRow).toBeVisible();
      const image = tabRow.locator('img.tab-icon');
      await expect(image).toHaveAttribute('src', /\/_favicon\/\?pageUrl=edge%3A%2F%2F/);
      await expect(image).toHaveAttribute('src', /size=32/);
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThanOrEqual(32);
      // 历史记录页保留蓝色图标；其余白色内置页图标在浅色侧栏中转为黑色。
      await expect(image).toHaveCSS('filter', index === 4 ? 'none' : 'brightness(0)');
    }
    // 将扩展页模拟为接管新标签页的入口，验证其图标不再取扩展 favicon。
    const overriddenTabId = await page.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id === undefined) throw new Error('扩展页标签 ID 缺失');
      document.title = '新标签页';
      return tab.id;
    });
    await expect(
      page.locator(`[data-tree-node="tab-${overriddenTabId}"] [data-browser-icon="newtab-edge"]`),
    ).toBeVisible();
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const id of created.slice(1)) {
      await expect(page.locator(`[data-tree-node="tab-${id}"] img.tab-icon`)).toHaveCSS(
        'filter',
        'none',
      );
    }
    // 系统保持深色时手动选择亮色，内置页图标也应恢复为黑色。
    await page.getByRole('button', { name: '外观：自动' }).click();
    await page.getByRole('menuitemradio', { name: '亮色' }).click();
    await expect(page.locator(`[data-tree-node="tab-${created[1]}"] img.tab-icon`)).toHaveCSS(
      'filter',
      'brightness(0)',
    );
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
