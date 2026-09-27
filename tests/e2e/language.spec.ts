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

        // 同一组侧栏依次切换新增语言，验证菜单、跨侧栏同步与阿拉伯语阅读方向。
        const additionalLanguages = [
          { locale: 'ar', name: 'العربية', settings: 'الإعدادات' },
          { locale: 'fr', name: 'Français', settings: 'Paramètres' },
          { locale: 'ru', name: 'Русский', settings: 'Настройки' },
          { locale: 'es', name: 'Español', settings: 'Configuración' },
        ] as const;
        for (const language of additionalLanguages) {
          await first.locator('.appearance-setting-row').last().getByRole('button').click();
          await first.getByRole('menuitemradio', { name: language.name }).click();
          for (const panel of [first, second]) {
            await expect(panel.locator('html')).toHaveAttribute('lang', language.locale);
            await expect(panel.locator('html')).toHaveAttribute(
              'dir',
              language.locale === 'ar' ? 'rtl' : 'ltr',
            );
            await expect(panel.locator('#settings-heading')).toHaveText(language.settings);
          }
          // 六种语言中较长的标签及阿拉伯语布局均不应撑破侧栏。
          for (const width of [320, 390, 480]) {
            await first.setViewportSize({ width, height: 844 });
            expect(
              await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
          }
          if (language.locale === 'ar') {
            // 右向左界面的左键应展开折叠窗口，右键应再次折叠。
            const disclosure = first.locator('.window-row').first().locator('[data-tree-toggle]');
            const windowNode = first.locator('.window-row').first().locator('[data-tree-node]');
            if ((await windowNode.getAttribute('aria-expanded')) === 'true') {
              await disclosure.click();
            }
            await expect(windowNode).toHaveAttribute('aria-expanded', 'false');
            await windowNode.focus();
            await first.keyboard.press('ArrowLeft');
            await expect(windowNode).toHaveAttribute('aria-expanded', 'true');
            await first.keyboard.press('ArrowRight');
            await expect(windowNode).toHaveAttribute('aria-expanded', 'false');
          }
        }

        // 设置控件仍可用 F6 进入；较长的译文在常见侧栏宽度内不能造成横向溢出。
        await first.locator('.window-target').first().focus();
        await first.keyboard.press('F6');
        await expect(first.locator('.settings-section').getByRole('switch').first()).toBeFocused();
      } finally {
        await context?.close();
        await rm(profile, { recursive: true, force: true });
      }
    });
  }
}

// 在全新配置目录中检查浏览器语言，确保侧栏和 Manifest 元数据都自动选择新增语言。
for (const language of [
  {
    browserLocale: 'ar-SA',
    locale: 'ar',
    settings: 'الإعدادات',
    action: 'فتح لوحة TabStash الجانبية',
    description: 'أرشفة',
  },
  {
    browserLocale: 'fr-FR',
    locale: 'fr',
    settings: 'Paramètres',
    action: 'Ouvrir le panneau latéral TabStash',
    description: 'Archivez',
  },
  {
    browserLocale: 'ru-RU',
    locale: 'ru',
    settings: 'Настройки',
    action: 'Открыть боковую панель TabStash',
    description: 'архивируйте',
  },
  {
    browserLocale: 'es-ES',
    locale: 'es',
    settings: 'Configuración',
    action: 'Abrir el panel lateral de TabStash',
    description: 'Archiva',
  },
] as const) {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright 要求解构夹具，本场景自行创建隔离浏览器。
  test(`chrome ${language.browserLocale} 自动语言和扩展元数据`, async ({}) => {
    const profile = await mkdtemp(join(tmpdir(), 'tabstash-chrome-auto-language-'));
    const extensionPath = resolve('.output/chrome-mv3');
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: await chromeExecutable(),
        headless: false,
        locale: language.browserLocale,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          `--lang=${language.browserLocale}`,
          '--no-first-run',
        ],
      });
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
      await expect(panel.locator('html')).toHaveAttribute('lang', language.locale);
      await expect(panel.locator('html')).toHaveAttribute(
        'dir',
        language.locale === 'ar' ? 'rtl' : 'ltr',
      );
      await expect(panel.locator('#settings-heading')).toHaveText(language.settings);
      const metadata = await panel.evaluate(() => {
        const chromeApi = (
          globalThis as unknown as {
            chrome: {
              i18n: { getMessage(key: string): string };
              runtime: { getManifest(): { description: string } };
            };
          }
        ).chrome;
        return {
          action: chromeApi.i18n.getMessage('actionTitle'),
          description: chromeApi.runtime.getManifest().description,
        };
      });
      expect(metadata.action).toBe(language.action);
      expect(metadata.description).toContain(language.description);
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
