import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

/**
 * 使用本地固定页面和隔离浏览器配置生成 README 截图。
 *
 * @param {'light' | 'dark'} colorScheme 截图采用的浏览器配色。
 * @param {'zh-CN' | 'ar-SA'} browserLocale 浏览器界面语言。
 * @param {string} origin 本地测试页面的地址。
 * @param {string} output 截图输出文件名。
 * @param {boolean} showLanguageMenu 是否展示完整的语言菜单。
 * @returns {Promise<void>} 截图写入 doc/screenshots 后完成。
 */
async function capture(colorScheme, browserLocale, origin, output, showLanguageMenu = false) {
  const profile = await mkdtemp(join(tmpdir(), 'tabstash-readme-'));
  const extensionPath = resolve('.output/edge-mv3');
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge',
      headless: false,
      locale: browserLocale,
      colorScheme,
      viewport: { width: 390, height: 844 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--lang=${browserLocale}`,
        '--no-first-run',
      ],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await expect(page.locator('.settings-section')).toBeVisible();

    // 测试窗口只访问本地服务器，避免真实网址、账号或浏览器配置进入文档图片。
    const target = await page.evaluate(async (base) => {
      const lang = document.documentElement.lang === 'ar' ? 'ar' : 'zh';
      const created = await chrome.windows.create({ url: `${base}/${lang}/first`, type: 'normal' });
      const first = created.tabs?.[0];
      if (created.id === undefined || first?.id === undefined) throw new Error('测试窗口未创建');
      await chrome.tabs.update(first.id, { pinned: true });
      const second = await chrome.tabs.create({
        windowId: created.id,
        url: `${base}/${lang}/second`,
      });
      if (second.id === undefined) throw new Error('第二个测试标签未创建');
      const groupId = await chrome.tabs.group({
        tabIds: [second.id],
        createProperties: { windowId: created.id },
      });
      await chrome.tabGroups.update(groupId, {
        title: lang === 'ar' ? 'مجموعة تجريبية' : '示例分组',
        color: 'blue',
      });
      return { windowId: created.id, panelWindowId: (await chrome.windows.getCurrent()).id };
    }, origin);
    const row = page.locator('.window-block').filter({
      has: page.locator(`[data-tree-node="window-${target.windowId}"]`),
    });
    await expect(row).toBeVisible();
    if (target.panelWindowId !== undefined) {
      await page.evaluate(
        async (windowId) => chrome.windows.update(windowId, { focused: true }),
        target.panelWindowId,
      );
    }
    const disclosure = row.locator('.disclosure-button');
    if ((await disclosure.getAttribute('aria-expanded')) === 'false') await disclosure.click();
    await expect(row.locator('.tab-row')).toHaveCount(2);
    await row.locator('.archive-actions button').first().click();
    const archive = page.locator('.archive-entry').first();
    await expect(archive).toBeVisible();
    await archive.locator('.archive-item > summary').click();
    await expect(archive.locator('.saved-tab')).toHaveCount(2);
    await expect(page.locator('html')).toHaveAttribute(
      'lang',
      browserLocale === 'ar-SA' ? 'ar' : 'zh-CN',
    );
    if (showLanguageMenu) {
      await page.locator('.appearance-setting-row').last().getByRole('button').click();
      await expect(page.getByRole('menuitemradio')).toHaveCount(7);
    }
    await page.screenshot({ path: resolve('doc/screenshots', output), animations: 'disabled' });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

/** @returns {Promise<void>} 四张真实扩展界面截图全部生成后完成。 */
async function main() {
  const server = createServer((request, response) => {
    const arabic = request.url?.startsWith('/ar/') ?? false;
    const second = request.url?.endsWith('/second') ?? false;
    const title = arabic
      ? second
        ? 'صفحة ثانية'
        : 'الصفحة الرئيسية'
      : second
        ? '第二页'
        : '示例首页';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<html><head><title>${title}</title></head><body>${title}</body></html>`);
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('本地页面服务未就绪');
    const origin = `http://127.0.0.1:${address.port}`;
    await capture('light', 'zh-CN', origin, 'edge-light.png');
    await capture('dark', 'zh-CN', origin, 'edge-dark.png');
    await capture('light', 'zh-CN', origin, 'edge-languages.png', true);
    await capture('light', 'ar-SA', origin, 'edge-arabic.png');
  } finally {
    await new Promise((done) => server.close(done));
  }
}

await main();
