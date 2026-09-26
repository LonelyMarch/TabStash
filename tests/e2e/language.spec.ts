import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, expect, test } from '@playwright/test';

/** 使用安装脚本准备的隔离 Chrome，不读取用户日常浏览器配置。 */
async function chromeExecutable(): Promise<string> {
  return (await readFile(resolve('.tmp/chrome-for-testing/executable-path.txt'), 'utf8')).trim();
}

for (const browserKind of ['edge', 'chrome'] as const) {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    // biome-ignore lint/correctness/noEmptyPattern: Playwright 要求解构夹具，本场景自行创建隔离浏览器。
    test(`${browserKind} ${locale} 语言选择和跨侧栏同步`, async ({}) => {
      const profile = await mkdtemp(join(tmpdir(), `tabstash-${browserKind}-language-`));
      const extensionPath = resolve(`.output/${browserKind}-mv3`);
      let context: BrowserContext | undefined;
      try {
        context = await chromium.launchPersistentContext(profile, {
          ...(browserKind === 'edge'
            ? { channel: 'msedge' as const }
            : { executablePath: await chromeExecutable() }),
          headless: false,
          locale,
          viewport: { width: 390, height: 844 },
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            `--lang=${locale}`,
            '--no-first-run',
          ],
        });
        const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
        const panelUrl = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;
        const first = await context.newPage();
        await first.goto(panelUrl);
        await expect(first.locator('.settings-section')).toBeVisible();
        const expected = locale === 'zh-CN' ? 'zh-CN' : 'en';
        await expect(first.locator('html')).toHaveAttribute('lang', expected);
        await expect(first.locator('#settings-heading')).toHaveText(
          locale === 'zh-CN' ? '设置' : 'Settings',
        );
        const manifest = await first.evaluate(() => ({
          description: (
            globalThis as unknown as {
              chrome: { runtime: { getManifest(): { description: string } } };
            }
          ).chrome.runtime.getManifest().description,
          action: (
            globalThis as unknown as {
              chrome: { i18n: { getMessage(key: string): string } };
            }
          ).chrome.i18n.getMessage('actionTitle'),
        }));
        expect(manifest.action).toBe(
          locale === 'zh-CN' ? '打开 TabStash 侧栏' : 'Open TabStash side panel',
        );
        expect(manifest.description).toContain(locale === 'zh-CN' ? '侧栏' : 'side panel');

        const second = await context.newPage();
        await second.goto(panelUrl);
        await expect(second.locator('html')).toHaveAttribute('lang', expected);
        const target = expected === 'en' ? 'zh-CN' : 'en';
        await first
          .getByRole('button', { name: expected === 'en' ? 'Language: Auto' : '语言：自动' })
          .click();
        await first
          .getByRole('menuitemradio', { name: target === 'en' ? 'English' : '简体中文' })
          .click();
        await expect(first.locator('html')).toHaveAttribute('lang', target);
        await expect(second.locator('html')).toHaveAttribute('lang', target);
        await expect(second.locator('#settings-heading')).toHaveText(
          target === 'en' ? 'Settings' : '设置',
        );
        await second.reload();
        await expect(second.locator('html')).toHaveAttribute('lang', target);

        // 设置控件仍可用 F6 进入；英文长度在常见侧栏宽度内不能造成横向溢出。
        await first.locator('.window-target').first().focus();
        await first.keyboard.press('F6');
        await expect(first.locator('.settings-section').getByRole('switch').first()).toBeFocused();
        for (const width of [320, 390, 480]) {
          await first.setViewportSize({ width, height: 844 });
          expect(
            await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        }
      } finally {
        await context?.close();
        await rm(profile, { recursive: true, force: true });
      }
    });
  }
}
