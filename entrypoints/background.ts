import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { AutoArchiveService } from '../src/application/archive/auto-archive';
import { ManualArchiveService } from '../src/application/archive/manual-archive';
import { RestoreService } from '../src/application/archive/restore';
import { captureWindowWithRuntimeTabs } from '../src/application/live-state/capture-window';
import { readLiveWindows } from '../src/application/live-state/live-windows';
import type { SnapshotStatus } from '../src/domain/archive/models';
import { parsePageProgress } from '../src/domain/archive/page-progress';
import { sortArchives } from '../src/domain/archive/presentation';
import { closeWindowVerified } from '../src/infrastructure/browser/close-window';
import { restoreBrowser } from '../src/infrastructure/browser/restore-browser';
import { snapshotReader } from '../src/infrastructure/browser/snapshot-reader';
import { ArchiveManagementRepository } from '../src/infrastructure/db/archive-management';
import { ClosedWindowRepository } from '../src/infrastructure/db/closed-windows';
import { TabStashDatabase } from '../src/infrastructure/db/database';
import { PageProgressRepository } from '../src/infrastructure/db/page-progress-repository';
import { ArchiveRepository } from '../src/infrastructure/db/repository';
import { RestoreRepository } from '../src/infrastructure/db/restore-repository';
import { onMessage, sendMessage } from '../src/infrastructure/messaging/protocol';
import { APPEARANCE_KEY, AppearanceStore } from '../src/infrastructure/storage/appearance';
import { SessionStore } from '../src/infrastructure/storage/session';
import { SettingsStore } from '../src/infrastructure/storage/settings';
import { ShadowTracker } from '../src/runtime/shadow-tracker';

/**
 * 在 Service Worker 启动时配置工具栏图标的侧栏行为。
 *
 * 同时注册类型化消息处理器。配置失败只记录错误，由用户仍可通过浏览器的
 * 侧栏入口尝试打开面板；此处不把启动时的一次异步调用视为永久业务状态。
 */
export default defineBackground(() => {
  // 监听和配置都放在入口函数内，避免 WXT 读取配置时执行浏览器 API。
  void browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => {
      console.error('无法配置 TabStash 侧栏入口', error);
    });

  // 消息监听器在每次 Service Worker 启动时同步注册，避免依赖常驻进程。
  onMessage('getLiveWindows', () => readLiveWindows());
  const database = new TabStashDatabase();
  const archives = new ArchiveRepository(database);
  const pageProgress = new PageProgressRepository(database);
  const archiveManagement = new ArchiveManagementRepository(database);
  onMessage('setArchivePinned', async ({ data }) => {
    await archiveManagement.setPinned(data.archiveId, data.pinned);
    void sendMessage('archivesInvalidated').catch(() => undefined);
  });
  onMessage('deleteArchive', async ({ data }) => {
    const removed = await archiveManagement.delete(data.archiveId);
    void sendMessage('archivesInvalidated').catch(() => undefined);
    return removed;
  });
  const closedWindows = new ClosedWindowRepository(database);
  const normalWindows = new Set<number>();
  const settings = new SettingsStore(browser.storage.local);
  const appearance = new AppearanceStore(browser.storage.local);
  const session = new SessionStore(browser.storage.session);
  let progressWrites = 0;
  /**
   * 内容脚本消息只能来自当前顶层普通网页；只接受与浏览器所见 URL 相同的数据。
   * 每个检查点按标签 ID 单独覆盖，避免同 URL 的多个标签互相串用进度。
   */
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!message || typeof message !== 'object') return;
    const request = message as { type?: string; progress?: unknown };
    if (request.type !== 'tabstash:progress-checkpoint') return;
    const progress = parsePageProgress(request.progress);
    const tab = sender.tab;
    if (
      !progress ||
      sender.frameId !== 0 ||
      !tab ||
      tab.id === undefined ||
      tab.windowId === undefined ||
      tab.incognito ||
      sender.url !== progress.url ||
      (tab.pendingUrl ?? tab.url) !== progress.url
    )
      return;
    return session.getSessionId().then(async (sessionId) => {
      await pageProgress.save({
        sessionId,
        tabId: tab.id as number,
        windowId: tab.windowId,
        updatedAt: Date.now(),
        progress,
      });
      if (++progressWrites % 128 === 0) await pageProgress.prune();
    });
  });
  void pageProgress.prune().catch((error: unknown) => console.error('网页进度清理失败', error));
  const restores = new RestoreRepository(database);
  const restoreService = new RestoreService({
    repository: restores,
    browser: restoreBrowser,
    sessionId: () => session.getSessionId(),
    changed: () => {
      void sendMessage('archivesInvalidated').catch(() => undefined);
      void sendMessage('restoreStateInvalidated').catch(() => undefined);
    },
  });
  onMessage('restoreArchive', ({ data }) => restoreService.execute(data));
  onMessage('getRestoreIssues', async () => {
    await restoreService.initialize();
    return restores.issues();
  });
  const manualArchive = new ManualArchiveService({
    repository: archives,
    session,
    capture: async (id) => {
      const { snapshot, runtimeTabs } = await captureWindowWithRuntimeTabs(id, snapshotReader);
      // 归档前并行要求各网页刷新检查点；无内容脚本或超时只影响网页进度。
      await Promise.all(
        runtimeTabs.map(async ({ tabId }) => {
          try {
            const response = await Promise.race([
              browser.tabs.sendMessage(tabId, { type: 'tabstash:capture-progress' }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('超时')), 700)),
            ]);
            const progress = parsePageProgress(response);
            const tab = snapshot.tabs.find((entry) =>
              runtimeTabs.some(
                (identity) => identity.tabId === tabId && identity.key === entry.key,
              ),
            );
            if (progress && progress.url === tab?.url)
              await pageProgress.save({
                sessionId: await session.getSessionId(),
                tabId,
                windowId: id,
                updatedAt: Date.now(),
                progress,
              });
          } catch {
            // 受限页面及后台标签继续使用最近一次已保存的检查点。
          }
        }),
      );
      return pageProgress.attach(await session.getSessionId(), snapshot, runtimeTabs);
    },
    close: (id) => closeWindowVerified(id, browser.windows),
    changed: () => {
      void sendMessage('archivesInvalidated').catch(() => undefined);
    },
  });
  onMessage('archiveWindow', ({ data }) => manualArchive.execute(data));
  onMessage('getArchives', async () => sortArchives(await archives.getArchives()));
  let snapshotNotificationTimer: ReturnType<typeof setTimeout> | undefined;
  /** 合并保存完成通知，面板只重新读取数据库状态，避免“通知→捕获→通知”循环。 */
  const notifySnapshots = () => {
    clearTimeout(snapshotNotificationTimer);
    snapshotNotificationTimer = setTimeout(() => {
      void sendMessage('snapshotStateInvalidated').catch(() => undefined);
    }, 180);
  };
  const shadows = new ShadowTracker({
    capture: (windowId) => captureWindowWithRuntimeTabs(windowId, snapshotReader),
    getSessionId: () => session.getSessionId(),
    save: (shadow) => archives.saveShadow(shadow),
    onSettled: notifySnapshots,
  });
  const autoArchive = new AutoArchiveService({
    repository: closedWindows,
    session,
    settings,
    settle: async (id) => {
      await shadows.settleClosing(id);
      await manualArchive.settle(id);
    },
    changed: () => {
      void sendMessage('archivesInvalidated').catch(() => undefined);
      void sendMessage('autoArchiveInvalidated').catch(() => undefined);
      notifySnapshots();
    },
  });
  onMessage('getAutoArchiveStatus', () => autoArchive.status());
  onMessage('retryAutoArchive', () => autoArchive.reconcile());

  /** 读取现存普通窗口 ID，不把隐私窗口带入持久快照。 */
  const readWindowIds = async () => {
    const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
    const ids = windows.flatMap((window) =>
      window.id === undefined || window.incognito ? [] : [window.id],
    );
    for (const id of ids) normalWindows.add(id);
    return ids;
  };
  /** 只检查已持久化数据；事件通知读取此状态，不额外触发捕获。 */
  const readSnapshotStatus = async (): Promise<SnapshotStatus> => {
    const ids = await readWindowIds();
    const sessionId = await session.getSessionId();
    const saved = (await Promise.all(ids.map((id) => archives.getShadow(sessionId, id)))).filter(
      (value) => value !== undefined,
    );
    return {
      windowCount: ids.length,
      savedWindowCount: saved.length,
      latestSavedAt: saved.length ? Math.max(...saved.map((value) => value.updatedAt)) : null,
      errors: shadows.getFailures(ids),
    };
  };
  let scan: Promise<SnapshotStatus> | undefined;
  /** 合并启动扫描和多个面板的手动刷新，避免并发捕获相互作废。 */
  const refreshShadows = (): Promise<SnapshotStatus> => {
    if (!scan) {
      scan = (async () => {
        const ids = await readWindowIds();
        await Promise.all(ids.map((id) => shadows.refresh(id)));
        return readSnapshotStatus();
      })().finally(() => {
        scan = undefined;
      });
    }
    return scan;
  };
  onMessage('getSnapshotStatus', readSnapshotStatus);
  onMessage('refreshSnapshots', refreshShadows);
  onMessage('getSettings', () => settings.get());
  onMessage('updateSettings', ({ data }) => settings.update(data));
  onMessage('getAppearance', () => appearance.get());
  onMessage('setAppearance', ({ data }) => appearance.set(data.mode));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'tabstash.settings.v1' in changes) {
      void sendMessage('settingsInvalidated').catch(() => undefined);
    }
    if (area === 'local' && APPEARANCE_KEY in changes) {
      void sendMessage('appearanceInvalidated').catch(() => undefined);
    }
  });
  onMessage('getPersistenceStatus', async () => {
    // 任一存储域失败都应反馈给面板；不删除数据库，也不自动重放旧操作。
    const [status] = await Promise.all([
      archives.getStatus(),
      settings.get(),
      session.getSessionId(),
    ]);
    return status;
  });

  let invalidationTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 合并短时间内密集到达的浏览器事件，仅通知侧栏重新读取完整状态。
   *
   * 计时器只影响界面刷新次数，不承载归档或其他持久业务状态。侧栏重新获得
   * 焦点时也会主动查询，所以 Service Worker 休眠不会破坏数据正确性。
   */
  const scheduleInvalidation = (): void => {
    if (invalidationTimer !== undefined) {
      clearTimeout(invalidationTimer);
    }
    invalidationTimer = setTimeout(() => {
      invalidationTimer = undefined;
      // 没有打开的侧栏时可能没有接收方；此类通知失败无需中断后台事件。
      void sendMessage('liveStateInvalidated').catch(() => undefined);
    }, 180);
  };

  browser.tabs.onCreated.addListener(scheduleInvalidation);
  browser.tabs.onRemoved.addListener(scheduleInvalidation);
  browser.tabs.onUpdated.addListener(scheduleInvalidation);
  browser.tabs.onMoved.addListener(scheduleInvalidation);
  browser.tabs.onActivated.addListener(scheduleInvalidation);
  browser.tabs.onAttached.addListener(scheduleInvalidation);
  browser.tabs.onDetached.addListener(scheduleInvalidation);
  browser.windows.onCreated.addListener(scheduleInvalidation);
  browser.windows.onRemoved.addListener(scheduleInvalidation);
  browser.windows.onFocusChanged.addListener(scheduleInvalidation);
  browser.tabGroups.onCreated.addListener(scheduleInvalidation);
  browser.tabGroups.onRemoved.addListener(scheduleInvalidation);
  browser.tabGroups.onMoved.addListener(scheduleInvalidation);
  browser.tabGroups.onUpdated.addListener(scheduleInvalidation);

  // 影子更新与 UI 失效通知分别处理；整窗关闭不能被普通“删除标签”刷新覆盖。
  browser.tabs.onCreated.addListener((tab) => shadows.schedule(tab.windowId));
  browser.tabs.onUpdated.addListener((_id, _change, tab) => shadows.schedule(tab.windowId));
  browser.tabs.onMoved.addListener((_id, info) => shadows.schedule(info.windowId));
  browser.tabs.onActivated.addListener((info) => shadows.schedule(info.windowId));
  browser.tabs.onRemoved.addListener((_id, info) => {
    if (info.isWindowClosing) shadows.markClosing(info.windowId);
    else shadows.schedule(info.windowId);
  });
  browser.tabs.onDetached.addListener((_id, info) => shadows.schedule(info.oldWindowId));
  browser.tabs.onAttached.addListener((_id, info) => shadows.schedule(info.newWindowId));
  browser.tabGroups.onCreated.addListener((group) => shadows.schedule(group.windowId));
  browser.tabGroups.onUpdated.addListener((group) => shadows.schedule(group.windowId));
  browser.tabGroups.onMoved.addListener((group) => shadows.schedule(group.windowId));
  browser.tabGroups.onRemoved.addListener((group) => shadows.schedule(group.windowId));
  browser.windows.onCreated.addListener((window) => {
    if (window.type === 'normal' && !window.incognito && window.id !== undefined) {
      normalWindows.add(window.id);
      shadows.markCreated(window.id);
    }
  });
  browser.windows.onBoundsChanged.addListener((window) => {
    if (window.id !== undefined) shadows.schedule(window.id);
  });
  browser.windows.onRemoved.addListener((id) => {
    shadows.markClosing(id);
    notifySnapshots();
    // 先同步确定已知普通窗口；Worker 刚唤醒时也可由已保存影子确认其来源。
    const known = normalWindows.delete(id);
    void (async () => {
      const sessionId = await session.getSessionId();
      if (known || (await archives.getShadow(sessionId, id))) await autoArchive.onClosed(id);
    })().catch((error: unknown) => console.error('无法记录窗口关闭事件', error));
  });
  // 监听器先同步注册，再开始异步扫描；Worker 重启不依赖之前的 Map 或计时器。
  void refreshShadows().catch((error: unknown) => console.error('初始化窗口快照失败', error));
  void restoreService
    .initialize()
    .then(() => {
      void sendMessage('archivesInvalidated').catch(() => undefined);
      void sendMessage('restoreStateInvalidated').catch(() => undefined);
    })
    .catch((error: unknown) => console.error('恢复记录核对失败', error));
  void autoArchive
    .reconcile()
    .catch((error: unknown) => console.error('自动归档启动核对失败', error));
});
