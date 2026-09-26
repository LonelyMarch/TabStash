import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';
import type { browser } from 'wxt/browser';

declare const chrome: typeof browser;

/**
 * 在隔离 Edge 中运行生产扩展，测试页面以普通扩展页承载侧栏 UI。
 * 原生侧栏开关与操作系统跨窗焦点不由本测试推断，仍以人工验收为准。
 */
// biome-ignore lint/correctness/noEmptyPattern: Playwright 要求以解构形式声明测试夹具，本测试自行启动隔离上下文。
test('Edge 归档全链路、后台重启及浏览器重启持久化', async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'tabstash-e2e-'));
  const extensionPath = resolve('.output/edge-mv3');
  const server = createServer((request, response) => {
    // 本地固定页面避免网站网络、登录和动态标题影响恢复断言。
    const title = request.url === '/second' ? '第二页' : '测试首页';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<html><head><title>${title}</title></head><body>${title}</body></html>`);
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地测试服务器未就绪');
  const origin = `http://127.0.0.1:${address.port}`;
  let context: BrowserContext | undefined;
  let panel: Page | undefined;

  /** 每次启动复用本测试目录，以验证真实磁盘持久化；不使用用户日常配置。 */
  async function launch(): Promise<Page> {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge',
      headless: false,
      locale: 'zh-CN',
      viewport: { width: 390, height: 844 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
      ],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(page.locator('.window-block').first()).toBeVisible();
    return page;
  }

  /** 从扩展页读取真实 IndexedDB，用于观察事件落盘，不写入或伪造业务结果。 */
  async function readRecords(table: string): Promise<Record<string, unknown>[]> {
    if (!panel) throw new Error('测试面板尚未打开');
    return panel.evaluate(async (tableName) => {
      const database = await new Promise<IDBDatabase>((accept, reject) => {
        const request = indexedDB.open('TabStash');
        request.onsuccess = () => accept(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<Record<string, unknown>[]>((accept, reject) => {
          const request = database.transaction(tableName).objectStore(tableName).getAll();
          request.onsuccess = () => accept(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        database.close();
      }
    }, table);
  }

  try {
    panel = await launch();
    testInfo.annotations.push({
      type: 'Edge',
      description: context?.browser()?.version() ?? 'unknown',
    });
    const target = await panel.evaluate(async (base) => {
      const window = await chrome.windows.create({ url: `${base}/first`, type: 'normal' });
      const first = window?.tabs?.[0];
      if (window?.id === undefined || first?.id === undefined) throw new Error('测试窗口未创建');
      await chrome.tabs.update(first.id, { pinned: true });
      const second = await chrome.tabs.create({ windowId: window.id, url: `${base}/second` });
      if (second.id === undefined) throw new Error('第二页未创建');
      const groupId = await chrome.tabs.group({
        tabIds: [second.id],
        createProperties: { windowId: window.id },
      });
      await chrome.tabGroups.update(groupId, { title: '测试组', color: 'blue' });
      return { windowId: window.id, firstId: first.id, secondId: second.id };
    }, origin);
    const windowRow = panel.locator('.window-block').filter({
      has: panel.locator(`[data-tree-node="window-${target.windowId}"]`),
    });
    await expect(windowRow).toBeVisible();
    const panelWindowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
    if (panelWindowId === undefined) throw new Error('测试面板所在窗口未识别');
    // 新窗口获得焦点后，留在旧窗口的面板必须收起全部实时窗口节点。
    await expect(panel.locator('.window-block .window-children')).toHaveCount(0);
    await panel.evaluate(
      async (windowId) => chrome.windows.update(windowId, { focused: true }),
      panelWindowId,
    );
    await expect(panel.locator(`[data-tree-node="window-${panelWindowId}"]`)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // 焦点实心点与非焦点空心点共用同一固定外框，避免字体字形造成大小偏差。
    const markerSizes = await panel.locator('.window-marker').evaluateAll((markers) =>
      markers.map((marker) => {
        const rect = marker.getBoundingClientRect();
        return [rect.width, rect.height];
      }),
    );
    expect(markerSizes).toEqual([
      [10, 10],
      [10, 10],
    ]);
    // 面板窗口重新获得焦点后，允许按原有规则手动展开目标窗口。
    await windowRow.locator('.disclosure-button').evaluate((button) => {
      if (button.getAttribute('aria-expanded') === 'false') (button as HTMLButtonElement).click();
    });
    await expect(windowRow.getByRole('button', { name: '第二页', exact: true })).toBeVisible();
    // 浏览器弹窗取得焦点时，普通窗口可能全部报告失焦；侧栏不应因此折叠。
    const popupWindowId = await panel.evaluate(
      async () => (await chrome.windows.create({ type: 'popup', url: 'about:blank' }))?.id,
    );
    if (popupWindowId === undefined) throw new Error('测试弹窗未创建');
    await expect
      .poll(() =>
        panel?.evaluate(async () => {
          const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
          return normalWindows.some((entry) => entry.focused);
        }),
      )
      .toBe(false);
    await expect(panel.locator('.window-block .window-children')).toHaveCount(2);
    await panel.evaluate(async (windowId) => chrome.windows.remove(windowId), popupWindowId);
    await panel.evaluate(
      async (windowId) => chrome.windows.update(windowId, { focused: true }),
      panelWindowId,
    );
    await windowRow.getByRole('button', { name: '测试首页，已固定', exact: true }).click();
    await expect
      .poll(() => panel?.evaluate(async (id) => (await chrome.tabs.get(id)).active, target.firstId))
      .toBe(true);
    await expect(panel.locator('.window-block .window-children')).toHaveCount(0);
    await panel.evaluate(
      async (windowId) => chrome.windows.update(windowId, { focused: true }),
      panelWindowId,
    );
    await expect(windowRow.locator('.window-children')).toBeVisible();

    // 两次手动归档产生不同创建时间，后置顶旧归档也不能改变创建时间顺序。
    const save = windowRow.getByRole('button', { name: '归档窗口（保留打开）', exact: true });
    await panel.evaluate(() => {
      // 记录操作期间的每次 DOM 更新，避免临时状态块让整个窗口树上下跳动。
      const unexpectedStatuses: string[] = [];
      const observer = new MutationObserver(() => {
        const status = document.querySelector('.status-immediate')?.textContent ?? '';
        if (status.includes('正在归档窗口')) unexpectedStatuses.push(status);
      });
      observer.observe(document.querySelector('.panel') as Element, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      (window as Window & { stopArchiveStatusWatch?: () => string[] }).stopArchiveStatusWatch =
        () => {
          observer.disconnect();
          return unexpectedStatuses;
        };
    });
    await save.click();
    await expect(panel.locator('.archive-entry')).toHaveCount(1);
    const markerPositions = await panel.evaluate((windowId) => {
      const live = document
        .querySelector(`[data-tree-node="window-${windowId}"] .window-marker`)
        ?.getBoundingClientRect();
      const saved = document
        .querySelector('.archive-entry .window-marker')
        ?.getBoundingClientRect();
      if (!live || !saved) throw new Error('窗口圆点未渲染');
      return { live: live.x, saved: saved.x };
    }, target.windowId);
    expect(markerPositions.saved).toBeCloseTo(markerPositions.live, 1);
    const unexpectedStatuses = await panel.evaluate(() => {
      const watch = window as Window & { stopArchiveStatusWatch?: () => string[] };
      return watch.stopArchiveStatusWatch?.();
    });
    expect(unexpectedStatuses).toEqual([]);
    const archivedTree = panel.locator('.archive-entry').first();
    await archivedTree.locator('.archive-item > summary').click();
    await expect(archivedTree.locator('.saved-tab')).toHaveCount(2);
    await expect(archivedTree.locator('.saved-tab.active')).toHaveCount(1);
    await expect(archivedTree.locator('.saved-tab .tab-icon')).toHaveCount(2);
    await expect(
      archivedTree.locator('.saved-group > summary .saved-group-chevron-open'),
    ).toBeVisible();
    const savedGroup = archivedTree.locator('.saved-group');
    await savedGroup.locator('summary').click();
    await expect(savedGroup.locator('.saved-group-chevron-closed')).toBeVisible();
    await expect(savedGroup.locator('.group-children')).toBeHidden();
    await savedGroup.locator('summary').click();
    await expect(savedGroup.locator('.group-children')).toBeVisible();
    const rowStyles = await panel.evaluate(() => {
      const live = document.querySelector('.window-block .tab-row');
      const saved = document.querySelector('.archive-entry .saved-tab');
      if (!live || !saved) throw new Error('实时标签或归档标签未渲染');
      const pick = (element: Element) => {
        const style = getComputedStyle(element);
        return [style.minHeight, style.fontSize, style.gap, style.paddingLeft];
      };
      return { live: pick(live), saved: pick(saved) };
    });
    expect(rowStyles.saved).toEqual(rowStyles.live);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(panel.locator('.archive-entry')).toHaveCount(2);
    const rows = panel.locator('.archive-entry');
    await rows.nth(0).getByRole('button', { name: '置顶', exact: true }).click();
    await expect(rows.nth(0).locator('strong')).toContainText('★');
    await rows.nth(1).getByRole('button', { name: '置顶', exact: true }).click();
    await expect
      .poll(async () => (await readRecords('archives')).filter((row) => row.pinned).length)
      .toBe(2);
    const stored = await readRecords('archives');
    const latest = Math.max(...stored.map((row) => Number(row.archivedAt)));
    await expect(rows.nth(0).locator('small')).toContainText(
      new Date(latest).toLocaleString('zh-CN'),
    );

    await rows.nth(0).getByRole('button', { name: '恢复', exact: true }).click();
    await expect(panel.locator('.archive-feedback')).toHaveCount(0);
    await expect(rows).toHaveCount(2);
    // 成功反馈已移除，直接等待浏览器完成窗口及标签组创建。
    await expect
      .poll(() =>
        panel?.evaluate(async (originalId) => {
          const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
          const restored = windows.find(
            (entry) => entry.id !== originalId && entry.tabs?.some((tab) => tab.title === '第二页'),
          );
          if (restored?.id === undefined) return false;
          const groups = await chrome.tabGroups.query({ windowId: restored.id });
          return groups.some((group) => group.title === '测试组');
        }, target.windowId),
      )
      .toBe(true);
    const restored = await panel.evaluate(async (originalId) => {
      const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
      const window = windows.find(
        (entry) => entry.id !== originalId && entry.tabs?.some((tab) => tab.title === '第二页'),
      );
      if (!window?.id) throw new Error('恢复窗口不存在');
      return { tabs: window.tabs, groups: await chrome.tabGroups.query({ windowId: window.id }) };
    }, target.windowId);
    expect(
      restored.tabs?.map((tab) => ({ url: tab.url, pinned: tab.pinned, active: tab.active })),
    ).toEqual([
      { url: `${origin}/first`, pinned: true, active: true },
      { url: `${origin}/second`, pinned: false, active: false },
    ]);
    expect(restored.groups).toMatchObject([{ title: '测试组', color: 'blue' }]);
    await rows.nth(0).getByRole('button', { name: '恢复并移除', exact: true }).click();
    await expect(panel.locator('.archive-feedback')).toHaveCount(0);
    await expect(rows).toHaveCount(1);

    await rows.first().getByRole('button', { name: '删除归档' }).click();
    await expect(panel.getByRole('dialog')).toHaveCount(0);
    await expect(rows).toHaveCount(0);
    await expect(panel.locator('.archive-feedback')).toHaveCount(0);

    // 自动归档 OFF：等待关闭记录明确处理完成后断言，不靠固定睡眠推断。
    const offWindow = await panel.evaluate(
      async () => (await chrome.windows.create({ url: 'about:blank' }))?.id,
    );
    if (offWindow === undefined) throw new Error('OFF 测试窗口未创建');
    await expect
      .poll(async () =>
        (await readRecords('shadows')).some((row) => row.runtimeWindowId === offWindow),
      )
      .toBe(true);
    await panel.evaluate((id) => chrome.windows.remove(id), offWindow);
    await expect
      .poll(async () =>
        (await readRecords('closedWindows')).some(
          (row) => row.windowId === offWindow && row.state !== 'pending',
        ),
      )
      .toBe(true);
    await expect(rows).toHaveCount(0);

    await panel.bringToFront();
    await panel.getByLabel('自动归档关闭的窗口').click();
    await expect(panel.getByLabel('自动归档关闭的窗口')).toBeChecked();
    await expect(panel.getByLabel('自动归档关闭的窗口')).toBeEnabled();
    // 归档并关闭在自动归档 ON 时也只产生一条记录。
    // 固定标签恢复已在上面验证；关闭路径使用普通标签，原生关闭确认另列人工验收。
    await panel.evaluate((id) => chrome.tabs.update(id, { pinned: false }), target.firstId);
    await windowRow.first().getByRole('button', { name: '归档并关闭窗口', exact: true }).click();
    await expect
      .poll(() =>
        panel?.evaluate(
          async (id) => (await chrome.windows.getAll()).some((window) => window.id === id),
          target.windowId,
        ),
      )
      .toBe(false);
    await expect
      .poll(async () =>
        (await readRecords('closedWindows')).some(
          (row) => row.windowId === target.windowId && row.state !== 'pending',
        ),
      )
      .toBe(true);
    await expect(rows).toHaveCount(1);
    const autoWindow = await panel.evaluate(
      async () => (await chrome.windows.create({ url: 'about:blank' }))?.id,
    );
    if (autoWindow === undefined) throw new Error('ON 测试窗口未创建');
    await expect
      .poll(async () =>
        (await readRecords('shadows')).some((row) => row.runtimeWindowId === autoWindow),
      )
      .toBe(true);
    await panel.evaluate((id) => chrome.windows.remove(id), autoWindow);
    await expect(rows).toHaveCount(2);

    // 通过 CDP 停止真实 MV3 Worker，重新加载 UI 使消息唤醒新实例。
    if (!context) throw new Error('Edge 上下文丢失');
    const cdp = await context.newCDPSession(panel);
    let workerVersion = '';
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      const version = versions.find(
        (entry) =>
          entry.scriptURL.startsWith('chrome-extension://') && entry.runningStatus === 'running',
      );
      if (version) workerVersion = version.versionId;
    });
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() => workerVersion).not.toBe('');
    await cdp.send('ServiceWorker.stopWorker', { versionId: workerVersion });
    await panel.reload();
    await expect(rows).toHaveCount(2);
    await expect(panel.locator('.window-block').first()).toBeVisible();
    await cdp.detach();
    await panel.getByLabel('自动归档关闭的窗口').click();
    await expect(panel.getByLabel('自动归档关闭的窗口')).not.toBeChecked();
    await expect(panel.getByLabel('自动归档关闭的窗口')).toBeEnabled();
    // 扩展自身页面属于明确不支持恢复的 URL，与普通标签一起验证部分失败保留归档。
    const restrictedId = await panel.evaluate(async () => {
      const window = await chrome.windows.create({ url: chrome.runtime.getURL('/sidepanel.html') });
      if (window?.id === undefined) throw new Error('受限 URL 测试窗口未创建');
      await chrome.tabs.create({ windowId: window.id, url: 'about:blank' });
      return window.id;
    });
    await panel
      .locator('.window-block')
      .filter({ has: panel.locator(`[data-tree-node="window-${restrictedId}"]`) })
      .getByRole('button', { name: '归档窗口（保留打开）', exact: true })
      .click();
    await expect(rows).toHaveCount(3);
    await rows.first().getByRole('button', { name: '恢复并移除', exact: true }).click();
    await expect(panel.locator('.archive-feedback')).toContainText(
      '已恢复 1/2 个标签。未完整恢复，原归档保留',
    );
    await expect(rows).toHaveCount(3);
    await rows.first().getByRole('button', { name: '删除归档' }).click();
    await expect(rows).toHaveCount(2);
    const beforeReload = await readRecords('archives');
    const panelUrl = panel.url();
    const reloadedWorker = context.waitForEvent('serviceworker');
    await panel.evaluate(() => {
      setTimeout(() => chrome.runtime.reload(), 0);
    });
    await reloadedWorker;
    panel = await context.newPage();
    await panel.goto(panelUrl);
    await expect(panel.locator('.archive-entry')).toHaveCount(2);
    expect(await readRecords('archives')).toEqual(beforeReload);
    await expect(panel.getByLabel('自动归档关闭的窗口')).not.toBeChecked();
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const beforeRestart = await readRecords('archives');
    await context.close();
    context = undefined;
    panel = await launch();
    await expect(panel.locator('.archive-entry')).toHaveCount(2);
    expect(await readRecords('archives')).toEqual(beforeRestart);
  } catch (error) {
    if (panel && !panel.isClosed()) {
      await testInfo.attach('diagnostics', {
        body: JSON.stringify({
          receipts: await readRecords('receipts'),
          text: await panel.locator('body').innerText(),
        }),
        contentType: 'application/json',
      });
    }
    if (panel && !panel.isClosed()) {
      await panel
        .screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await context?.close();
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
    // 只删除 mkdtemp 返回的本次隔离配置目录，不触碰用户配置或开发会话。
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
