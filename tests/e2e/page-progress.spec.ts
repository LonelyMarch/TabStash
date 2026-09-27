import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';
import type { browser } from 'wxt/browser';
import type { PageProgress } from '../../src/domain/archive/models';

declare const chrome: typeof browser;

/** 从隔离扩展的 IndexedDB 读取真实归档和检查点，不伪造内容脚本结果。 */
async function records(page: Page, table: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('TabStash');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const request = database.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, table);
}

/** 等待浏览器页面的元数据后设置两个滚动区域与视频时间。 */
async function setProgress(page: Page, top: number): Promise<void> {
  await page.evaluate(async (position) => {
    const video = document.querySelector('video');
    const inner = document.querySelector('#inner');
    if (!(video instanceof HTMLVideoElement) || !(inner instanceof HTMLElement))
      throw new Error('测试页面缺少视频或内层滚动区域');
    if (video.readyState < 1)
      await new Promise<void>((resolve) =>
        video.addEventListener('loadedmetadata', () => resolve(), { once: true }),
      );
    video.currentTime = 1.5;
    inner.scrollTop = 350;
    window.scrollTo(0, position);
  }, top);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(top - 100);
  await expect
    .poll(() =>
      page.locator('video').evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(1);
  const media = await page.locator('video').evaluate((element) => {
    const video = element as HTMLVideoElement;
    return { time: video.currentTime, duration: video.duration };
  });
  expect(media.time).toBeGreaterThan(1);
  expect(Number.isFinite(media.duration)).toBe(true);
}

/** 确认恢复的是页面内部状态，且视频不会因恢复而自动播放。 */
async function expectProgress(page: Page, top: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(top - 100);
  await expect
    .poll(() => page.locator('#inner').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(250);
  await expect
    .poll(() =>
      page.locator('video').evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(1);
  expect(
    await page.locator('video').evaluate((element) => (element as HTMLVideoElement).paused),
  ).toBe(true);
}

for (const browserKind of ['edge', 'chrome'] as const) {
  // biome-ignore lint/correctness/noEmptyPattern: 本测试主动启动隔离浏览器，不使用 Playwright 默认 page。
  test(`${browserKind} 手动与自动归档恢复网页进度`, async ({}) => {
    const profile = await mkdtemp(join(tmpdir(), `tabstash-${browserKind}-progress-`));
    const clip = await readFile(resolve('tests/fixtures/progress.webm'));
    const server = createServer((request, response) => {
      if (request.url === '/clip.webm') {
        // 媒体 seek 会发 Range 请求；测试服务器需像真实静态服务器一样返回 206。
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(clip.length - 1, range[2] ? Number(range[2]) : clip.length - 1);
          response.writeHead(206, {
            'Content-Type': 'video/webm',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${clip.length}`,
            'Content-Length': end - start + 1,
          });
          response.end(clip.subarray(start, end + 1));
        } else {
          response.writeHead(200, {
            'Content-Type': 'video/webm',
            'Accept-Ranges': 'bytes',
            'Content-Length': clip.length,
          });
          response.end(clip);
        }
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>进度测试页</title></head><body>
        <div id="inner" style="height:150px;overflow:auto"><div style="height:1000px">内层内容</div></div>
        <video preload="auto" src="/clip.webm" width="80" height="60"></video>
        <div style="height:2600px">页面内容</div></body></html>`);
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('本地页面未就绪');
    const url = `http://127.0.0.1:${address.port}/page`;
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(profile, {
        ...(browserKind === 'edge'
          ? { channel: 'msedge' as const }
          : {
              executablePath: (
                await readFile(resolve('.tmp/chrome-for-testing/executable-path.txt'), 'utf8')
              ).trim(),
            }),
        headless: false,
        locale: 'zh-CN',
        viewport: { width: 390, height: 844 },
        args: [
          `--disable-extensions-except=${resolve(`.output/${browserKind}-mv3`)}`,
          `--load-extension=${resolve(`.output/${browserKind}-mv3`)}`,
          '--lang=zh-CN',
          '--no-first-run',
        ],
      });
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
      const firstPage = context.waitForEvent('page');
      await panel.evaluate(async (pageUrl) => chrome.windows.create({ url: pageUrl }), url);
      const site = await firstPage;
      await site.waitForURL(url);
      await setProgress(site, 800);
      const tab = await panel.evaluate(async (pageUrl) => {
        const found = (await chrome.tabs.query({ url: pageUrl }))[0];
        if (found?.id === undefined) throw new Error('测试标签未找到');
        return { id: found.id, windowId: found.windowId };
      }, url);
      const windowRow = panel.locator('.window-block').filter({
        has: panel.locator(`[data-tree-node="window-${tab.windowId}"]`),
      });
      await windowRow.getByRole('button', { name: '归档窗口（保留打开）' }).click();
      await expect(panel.locator('.archive-entry')).toHaveCount(1);
      const saved = await records(panel, 'archives');
      if (!saved[0]?.snapshot) throw new Error('手动归档快照不存在');
      const savedProgress = (
        saved[0].snapshot as { tabs: { progress?: { scrolls: unknown[]; media: unknown[] } }[] }
      ).tabs.find((entry) => entry.progress)?.progress;
      expect(savedProgress?.scrolls).toHaveLength(2);
      expect(savedProgress?.media).toHaveLength(1);

      await panel.locator('.archive-entry').getByRole('button', { name: '恢复并移除' }).click();
      await expect(panel.locator('.archive-entry')).toHaveCount(0);
      await expect
        .poll(() => context?.pages().filter((page) => page.url() === url && page !== site).length)
        .toBeGreaterThan(0);
      const restored = context.pages().find((page) => page.url() === url && page !== site);
      if (!restored) throw new Error('恢复网页未找到');
      await expectProgress(restored, 800);

      await panel.getByLabel('自动归档关闭的窗口').click();
      const newPage = context.waitForEvent('page');
      const autoWindowId = await panel.evaluate(
        async (pageUrl) => (await chrome.windows.create({ url: pageUrl }))?.id,
        url,
      );
      if (autoWindowId === undefined) throw new Error('自动归档测试窗口未创建');
      const autoSite = await newPage;
      await autoSite.waitForURL(url);
      await setProgress(autoSite, 1000);
      const autoTabId = await panel.evaluate(
        async (windowId) => (await chrome.tabs.query({ windowId }))[0]?.id,
        autoWindowId,
      );
      if (autoTabId === undefined) throw new Error('自动归档测试标签未找到');
      await expect
        .poll(async () => {
          const checkpoint = (await records(panel, 'pageProgress')).find(
            (entry) => entry.tabId === autoTabId,
          );
          return (
            (checkpoint?.progress as { scrolls?: { top: number }[] } | undefined)?.scrolls?.[0]
              ?.top ?? 0
          );
        })
        .toBeGreaterThan(900);
      await panel.evaluate(async (windowId) => chrome.windows.remove(windowId), autoWindowId);
      await expect(panel.locator('.archive-entry')).toHaveCount(1);
      const automatic = (await records(panel, 'archives')).find(
        (entry) => entry.source === 'auto-close',
      );
      if (!automatic?.snapshot) throw new Error('自动归档快照不存在');
      expect(
        (automatic.snapshot as { tabs: { progress?: PageProgress }[] }).tabs[0]?.progress
          ?.scrolls[0]?.top,
      ).toBeGreaterThan(900);
      await panel
        .locator('.archive-entry')
        .getByRole('button', { name: '恢复', exact: true })
        .click();
      await expect
        .poll(
          () =>
            context
              ?.pages()
              .filter((page) => page.url() === url && page !== site && page !== restored).length,
        )
        .toBeGreaterThan(0);
      const autoRestored = context
        .pages()
        .find((page) => page.url() === url && page !== site && page !== restored);
      if (!autoRestored) throw new Error('自动归档恢复网页未找到');
      await expectProgress(autoRestored, 1000);
    } finally {
      await context?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(profile, { recursive: true, force: true });
    }
  });
}
