import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, expect, test } from '@playwright/test';

type BrowserKind = 'edge' | 'chrome';
type ColorMode = 'light' | 'dark';

const browserColors: Record<BrowserKind, Record<ColorMode, string>> = {
  edge: { light: 'rgb(247, 247, 247)', dark: 'rgb(32, 32, 32)' },
  chrome: { light: 'rgb(248, 250, 253)', dark: 'rgb(32, 33, 36)' },
};

/** 从安装脚本写入的本地路径读取免安装 Chrome，不读取用户日常浏览器配置。 */
async function chromeExecutable(): Promise<string> {
  return (await readFile(resolve('.tmp/chrome-for-testing/executable-path.txt'), 'utf8')).trim();
}

for (const browserKind of ['edge', 'chrome'] as const) {
  for (const colorMode of ['light', 'dark'] as const) {
    // biome-ignore lint/correctness/noEmptyPattern: Playwright 要求解构夹具，本场景自行创建隔离浏览器。
    test(`${browserKind} ${colorMode} 侧栏外观与模式同步`, async ({}) => {
      const profile = await mkdtemp(join(tmpdir(), `tabstash-${browserKind}-appearance-`));
      const extensionPath = resolve(`.output/${browserKind}-mv3`);
      let context: BrowserContext | undefined;
      try {
        context = await chromium.launchPersistentContext(profile, {
          ...(browserKind === 'edge'
            ? { channel: 'msedge' as const }
            : { executablePath: await chromeExecutable() }),
          headless: false,
          locale: 'zh-CN',
          colorScheme: colorMode,
          viewport: { width: 390, height: 844 },
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--no-first-run',
          ],
        });
        const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
        const panelUrl = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;
        const page = await context.newPage();
        await page.goto(panelUrl);
        await expect(page.locator('.settings-section')).toBeVisible();
        // 标题保留给屏幕阅读器；仅验证它不占用可见布局。
        await expect(page.locator('h1')).toHaveClass(/visually-hidden/);
        expect(
          await page.locator('h1').evaluate((element) => element.getBoundingClientRect().width),
        ).toBe(1);
        await expect(page.getByText('状态', { exact: true })).toHaveCount(0);
        await expect(
          page.locator('.settings-section').getByRole('switch', { name: '自动归档关闭的窗口' }),
        ).toBeEnabled();
        await expect(page.locator('html')).toHaveAttribute('data-browser', browserKind);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'auto');
        await expect(page.locator('body')).toHaveCSS(
          'background-color',
          browserColors[browserKind][colorMode],
        );
        if (browserKind === 'chrome') {
          await expect
            .poll(() =>
              page.evaluate(async () => {
                await document.fonts.ready;
                return document.fonts.check('14px Roboto');
              }),
            )
            .toBe(true);
        }

        // 自动模式应在侧栏不重新加载的情况下响应配色变化。
        const opposite = colorMode === 'dark' ? 'light' : 'dark';
        await page.emulateMedia({ colorScheme: opposite });
        await expect(page.locator('body')).toHaveCSS(
          'background-color',
          browserColors[browserKind][opposite],
        );
        await page.emulateMedia({ colorScheme: colorMode });

        // 树和设置控件使用适中密度，改变宽度时不能发生横向溢出。
        await expect(page.locator('.window-row').first()).toHaveCSS('min-height', '40px');
        await expect(page.locator('.tab-row').first()).toHaveCSS('min-height', '34px');
        for (const width of [320, 390, 480]) {
          await page.setViewportSize({ width, height: 844 });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          // 内容较短时，设置区域应在侧栏底部，不应停在归档列表正下方。
          expect(
            await page
              .locator('.settings-section')
              .evaluate((section) =>
                Math.abs(section.getBoundingClientRect().bottom - innerHeight),
              ),
          ).toBeLessThan(32);
        }
        await page.setViewportSize({ width: 390, height: 844 });
        // F6 应先进入底部设置区的首个开关，返回时仍聚焦实时树。
        await page.locator('.window-target').first().focus();
        await page.keyboard.press('F6');
        await expect(page.getByRole('switch', { name: '切换时打开目标窗口侧栏' })).toBeFocused();
        await page.keyboard.press('F6');
        await expect(page.locator('.window-target').first()).toBeFocused();

        const optionName = opposite === 'dark' ? '暗色' : '亮色';
        await page.getByRole('button', { name: '外观：自动' }).click();
        await page.getByRole('menuitemradio', { name: optionName }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', opposite);
        await expect(page.locator('body')).toHaveCSS(
          'background-color',
          browserColors[browserKind][opposite],
        );
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('data-theme', opposite);

        // 同一个扩展的第二个页面修改模式后，原面板通过后台通知同步。
        const second = await context.newPage();
        await second.goto(panelUrl);
        await expect(second.locator('html')).toHaveAttribute('data-theme', opposite);
        await second.getByRole('button', { name: `外观：${optionName}` }).click();
        await second.getByRole('menuitemradio', { name: '自动' }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'auto');
        await second.close();

        // 外观菜单由 Radix Portal 渲染，也必须继承当前浏览器配色。
        await page.getByRole('button', { name: '外观：自动' }).click();
        const surfaceColor =
          colorMode === 'light'
            ? 'rgb(255, 255, 255)'
            : browserKind === 'edge'
              ? 'rgb(43, 43, 43)'
              : 'rgb(41, 42, 45)';
        await expect(page.getByRole('menu')).toHaveCSS('background-color', surfaceColor);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: '归档窗口（保留打开）' }).first().hover();
        await expect(page.getByRole('tooltip', { name: '归档', exact: true })).toBeVisible();
        await page.mouse.move(0, 700);
        await expect(page.getByRole('tooltip', { name: '归档', exact: true })).toBeHidden();
        await page.getByRole('button', { name: '归档并关闭窗口' }).first().hover();
        await expect(page.getByRole('tooltip', { name: '归档并关闭' })).toBeVisible();
        await page.mouse.move(0, 700);
        await page.getByRole('button', { name: '归档窗口（保留打开）' }).first().click();
        await expect(page.locator('.archive-entry')).toHaveCount(1);
        const disclosure = page.locator('.archive-item > summary .archive-disclosure');
        await expect(disclosure.locator('.archive-chevron-closed')).toBeVisible();
        await disclosure.click();
        await expect(disclosure.locator('.archive-chevron-open')).toBeVisible();
        await disclosure.click();
        await expect(disclosure.locator('.archive-chevron-closed')).toBeVisible();
        await expect(page.locator('.restore-buttons button')).toHaveCount(4);
        // 展开归档后检查标签行，避免旧的原生列表样式在窄侧栏重新引入溢出。
        await disclosure.click();
        await expect(page.locator('.archive-entry .saved-tab').first()).toBeVisible();
        await page.setViewportSize({ width: 320, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        // 四个操作与归档标题同排，且其点击区域没有越过侧栏边界。
        expect(
          await page.locator('.archive-entry').evaluate((entry) => {
            const summary = entry.querySelector('summary')?.getBoundingClientRect();
            const buttons = [...entry.querySelectorAll('.restore-buttons button')];
            return Boolean(
              summary &&
                buttons.every((button) => {
                  const rect = button.getBoundingClientRect();
                  return (
                    rect.top >= summary.top &&
                    rect.bottom <= summary.bottom &&
                    rect.right <= innerWidth
                  );
                }),
            );
          }),
        ).toBe(true);
        for (const button of await page.locator('.restore-buttons button').all()) {
          await expect(button).toBeVisible();
        }
        await page.getByRole('button', { name: '恢复并移除' }).hover();
        await expect(page.getByRole('tooltip', { name: '恢复并移除' })).toBeVisible();
        await page.mouse.move(0, 700);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: '删除归档' }).hover();
        await expect(page.getByRole('tooltip', { name: '删除', exact: true })).toBeVisible();
        await page.mouse.move(0, 700);
        await page.getByRole('button', { name: '删除归档' }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.locator('.archive-entry')).toHaveCount(0);
        await expect(page.locator('.archive-feedback')).toHaveCount(0);
      } finally {
        await context?.close();
        await rm(profile, { recursive: true, force: true });
      }
    });
  }
}
