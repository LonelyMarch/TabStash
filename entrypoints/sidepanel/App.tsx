import { ChevronDown, ChevronRight, Pin } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type {
  ArchiveCommand,
  ArchivedWindow,
  SnapshotStatus,
} from '../../src/domain/archive/models';
import { adjacentWindowId } from '../../src/domain/window/adjacent-window';
import type { LiveGroup, LiveTab, LiveWindow } from '../../src/domain/window/live-tree';
import { type Diagnostic, diagnosticFromError, translateDiagnostic } from '../../src/i18n/core';
import type { MessageKey } from '../../src/i18n/messages';
import { useLanguage } from '../../src/i18n/react';
import { onMessage, sendMessage } from '../../src/infrastructure/messaging/protocol';
import { ArchiveActions } from '../../src/ui/ArchiveActions';
import { ArchiveList } from '../../src/ui/ArchiveList';
import { AutoArchiveControl } from '../../src/ui/AutoArchiveControl';
import { AppearanceControl } from '../../src/ui/appearance/AppearanceControl';
import { SettingSwitch } from '../../src/ui/controls/SettingSwitch';
import { LanguageControl } from '../../src/ui/language/LanguageControl';
import { TabIcon } from '../../src/ui/TabIcon';
import { useTreeKeyboard } from '../../src/ui/use-tree-keyboard';

interface Notice {
  key: MessageKey;
  params?: Record<string, string | number>;
  urgent: boolean;
}

/**
 * 渲染一个当前标签；分组内外共用同一激活行为。
 *
 * @param props.tab 当前浏览器标签。
 * @param props.grouped 是否位于标签组内，用于确定缩进层级。
 * @param props.parentKey 所属窗口或标签组的导航标识。
 * @param props.onActivate 用户点击标签时调用的激活函数。
 * @returns 可点击的实时标签行。
 */
function TabRow({
  tab,
  grouped,
  parentKey,
  onActivate,
}: {
  tab: LiveTab;
  grouped: boolean;
  parentKey: string;
  onActivate: (tab: LiveTab) => Promise<void>;
}) {
  const { t } = useLanguage();
  return (
    <button
      aria-current={tab.active ? 'page' : undefined}
      aria-label={`${tab.title || t('untitledTab')}${tab.pinned ? t('pinned') : ''}`}
      className={`tab-row${grouped ? ' grouped' : ''}${tab.active ? ' active' : ''}`}
      data-tree-node={`tab-${tab.id}`}
      data-tree-parent={parentKey}
      onClick={() => {
        void onActivate(tab);
      }}
      title={tab.url ?? tab.title}
      type="button"
    >
      <TabIcon
        favIconUrl={tab.favIconUrl}
        key={`${tab.url ?? 'missing'}|${tab.title}|${tab.favIconUrl ?? 'missing'}`}
        title={tab.title || t('untitledTab')}
        url={tab.url}
      />
      <span className="node-title">{tab.title || t('untitledTab')}</span>
      {tab.pinned ? <Pin aria-hidden="true" className="pinned-icon" size={12} /> : null}
    </button>
  );
}

/**
 * 从 Background 读取并展示 Window → Group → Tab 实时树。
 *
 * 展开状态仅属于 Side Panel，点击标签组不修改 Edge 原生标签组的折叠状态。
 *
 * @returns 当前窗口树及 Phase 0 已验证的跨窗口快捷键界面。
 */
export default function App() {
  const { locale, t } = useLanguage();
  const [windows, setWindows] = useState<LiveWindow[]>([]);
  const [panelWindowId, setPanelWindowId] = useState<number | null>(null);
  const [lastFocusedWindowId, setLastFocusedWindowId] = useState<number | null>(null);
  const [openTargetPanel, setOpenTargetPanel] = useState(true);
  const [expandedWindows, setExpandedWindows] = useState<Record<number, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<number, boolean>>({});
  const [message, setMessage] = useState<Notice | null>({ key: 'loadingWindows', urgent: true });
  const [storageMessage, setStorageMessage] = useState<Notice | null>({
    key: 'loadingStorage',
    urgent: true,
  });
  const [snapshotMessage, setSnapshotMessage] = useState<Notice | null>({
    key: 'loadingSnapshots',
    urgent: true,
  });
  const [snapshotState, setSnapshotState] = useState<SnapshotStatus | null>(null);
  const [archiveWarning, setArchiveWarning] = useState<Diagnostic | null>(null);
  const snapshotGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const storageGeneration = useRef(0);
  const { treeRef, controlsRef, controlsMode } = useTreeKeyboard();
  const [archivedWindows, setArchivedWindows] = useState<ArchivedWindow[]>([]);
  const [archiveError, setArchiveError] = useState<Diagnostic | null>({ key: 'loadingArchives' });
  const [busyWindows, setBusyWindows] = useState<Set<number>>(new Set());
  const pendingArchives = useRef(new Map<number, ArchiveCommand>());
  const activeArchives = useRef(new Set<number>());
  const archiveGeneration = useRef(0);

  useEffect(() => {
    let mounted = true;
    // 侧栏实例只属于一个浏览器窗口；不能用全局焦点窗口推断本侧栏所在窗口。
    void browser.windows
      .getCurrent()
      .then((currentWindow) => {
        if (mounted && currentWindow.id !== undefined) setPanelWindowId(currentWindow.id);
      })
      .catch((error: unknown) => {
        if (mounted) {
          console.error('Could not identify panel window', error);
          setMessage({ key: 'panelWindowUnknown', urgent: true });
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  /** 读取持久归档；失败时保留已显示的数据，并区分错误与空列表。 */
  const refreshArchives = useCallback(async () => {
    const generation = ++archiveGeneration.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Archive read timed out')), 8000);
      });
      const data = await Promise.race([sendMessage('getArchives'), timeout]);
      if (generation !== archiveGeneration.current) return;
      setArchivedWindows(data);
      setArchiveError(null);
    } catch (error: unknown) {
      if (generation === archiveGeneration.current)
        setArchiveError(diagnosticFromError(error, 'archiveReadFailed'));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, []);

  /**
   * 核对窗口持久快照，错误单独反馈。
   * @param recapture 用户主动刷新时重新捕获；后台通知只读取已保存状态，避免循环。
   */
  const refreshSnapshotStatus = useCallback(async (recapture = false): Promise<void> => {
    const generation = ++snapshotGeneration.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Snapshot check timed out')), 8000);
      });
      const status = await Promise.race([
        recapture ? sendMessage('refreshSnapshots') : sendMessage('getSnapshotStatus'),
        timeout,
      ]);
      if (generation !== snapshotGeneration.current) return;
      setSnapshotState(status);
      setSnapshotMessage(null);
    } catch (error: unknown) {
      if (generation === snapshotGeneration.current) {
        console.error('Snapshot status unavailable', error);
        setSnapshotMessage({ key: 'snapshotUnavailable', urgent: true });
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const removeListener = onMessage('snapshotStateInvalidated', () => {
      void refreshSnapshotStatus();
    });
    void refreshSnapshotStatus();
    return () => {
      removeListener();
      snapshotGeneration.current += 1;
    };
  }, [refreshSnapshotStatus]);

  /**
   * 检查归档数据库、设置和会话存储，错误单独展示，不阻断实时标签树。
   *
   * 只读取状态和初始化会话标识；不生成测试归档，不修改自动归档设置。
   */
  const refreshStorageStatus = useCallback(async (): Promise<void> => {
    const generation = ++storageGeneration.current;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Storage check timed out')), 8000);
      });
      await Promise.race([sendMessage('getPersistenceStatus'), timeout]);
      if (generation !== storageGeneration.current) return;
      setStorageMessage(null);
    } catch (error: unknown) {
      if (generation === storageGeneration.current) {
        console.error('Local storage unavailable', error);
        setStorageMessage({ key: 'storageUnavailable', urgent: true });
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }, []);

  useEffect(() => {
    const remove = onMessage('archivesInvalidated', () => {
      void refreshArchives();
      void refreshStorageStatus();
    });
    void refreshArchives();
    return () => {
      remove();
      archiveGeneration.current += 1;
    };
  }, [refreshArchives, refreshStorageStatus]);

  /**
   * 发起稳定 ID 的归档请求；超时或响应丢失后重试同一请求，不重新生成归档。
   * @param windowId 目标实时窗口。
   * @param closeAfterArchive 是否在保存成功后关闭窗口。
   */
  async function archiveWindow(windowId: number, closeAfterArchive: boolean): Promise<void> {
    if (activeArchives.current.has(windowId)) return;
    const previous = pendingArchives.current.get(windowId);
    if (previous && previous.closeAfterArchive !== closeAfterArchive) {
      setMessage({ key: 'archiveBusyUnconfirmed', urgent: true });
      return;
    }
    const command = previous ?? { requestId: crypto.randomUUID(), windowId, closeAfterArchive };
    pendingArchives.current.set(windowId, command);
    activeArchives.current.add(windowId);
    setBusyWindows(new Set(activeArchives.current));
    // 忙碌状态由窗口行按钮展示；不要在列表上方临时插入状态块，以免整栏跳动。
    setMessage(null);
    setArchiveWarning(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Archive result timed out')), 15000);
      });
      const result = await Promise.race([sendMessage('archiveWindow', command), timeout]);
      pendingArchives.current.delete(windowId);
      setArchiveWarning(result.warning ?? null);
      setMessage(
        result.warning
          ? null
          : { key: result.outcome === 'closed' ? 'archivedClosed' : 'archivedOpen', urgent: false },
      );
      void refreshArchives();
      void refreshStorageStatus();
    } catch (error: unknown) {
      console.error('Archive result unconfirmed', error);
      setMessage({ key: 'archiveUnconfirmed', urgent: true });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      activeArchives.current.delete(windowId);
      setBusyWindows(new Set(activeArchives.current));
    }
  }

  useEffect(() => {
    void refreshStorageStatus();
    return () => {
      storageGeneration.current += 1;
    };
  }, [refreshStorageStatus]);

  /**
   * 重新查询完整浏览器状态，仅采用最后一次请求的结果。
   *
   * @returns 查询完成时解析的 Promise。
   */
  const refreshLiveWindows = useCallback(async (): Promise<void> => {
    const generation = ++refreshGeneration.current;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      // 后台异常或消息端口失效时，不能让界面无限停留在“正在读取”。
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('Background window read timed out'));
        }, 8000);
      });
      const latestWindows = await Promise.race([sendMessage('getLiveWindows'), timeout]);
      if (generation !== refreshGeneration.current) {
        return;
      }

      setWindows(latestWindows);
      const focusedWindow = latestWindows.find((liveWindow) => liveWindow.focused);
      // 工具栏弹窗会暂时让普通窗口全部失焦；仅观察到另一个普通窗口时更新记忆。
      if (focusedWindow) setLastFocusedWindowId(focusedWindow.id);
      setMessage((previous) =>
        previous?.key === 'loadingWindows'
          ? { key: 'windowsRead', params: { count: latestWindows.length }, urgent: false }
          : previous,
      );
    } catch (error: unknown) {
      if (generation === refreshGeneration.current) {
        console.error('Could not read windows', error);
        setMessage({ key: 'windowsReadFailed', urgent: true });
      }
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }, []);

  useEffect(() => {
    // Background 的通知只表示状态变化；面板始终重新读取浏览器完整状态。
    const removeInvalidationListener = onMessage('liveStateInvalidated', () => {
      void refreshLiveWindows();
    });
    const onPanelFocus = (): void => {
      void refreshLiveWindows();
    };
    const onVisibilityChanged = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshLiveWindows();
      }
    };

    void refreshLiveWindows();
    window.addEventListener('focus', onPanelFocus);
    document.addEventListener('visibilitychange', onVisibilityChanged);
    return () => {
      removeInvalidationListener();
      window.removeEventListener('focus', onPanelFocus);
      document.removeEventListener('visibilitychange', onVisibilityChanged);
      // 卸载后旧请求即使返回，也不能再覆盖新面板实例的数据。
      refreshGeneration.current += 1;
    };
  }, [refreshLiveWindows]);

  /**
   * 在当前用户操作中请求目标窗口的侧栏。
   *
   * @param windowId 目标窗口运行时 ID。
   * @returns 侧栏请求的 Promise；开关关闭时立即解析。
   */
  const requestTargetPanel = useCallback(
    (windowId: number): Promise<void> => {
      // sidePanel.open 必须在第一次 await 前调用，保留键盘或点击的用户手势。
      if (!openTargetPanel || typeof browser.sidePanel?.open !== 'function') {
        return Promise.resolve();
      }
      return browser.sidePanel.open({ windowId });
    },
    [openTargetPanel],
  );

  /**
   * 聚焦目标窗口，并在需要时打开该窗口的 Side Panel。
   *
   * @param windowId 目标窗口运行时 ID。
   */
  const switchToWindow = useCallback(
    async (windowId: number): Promise<void> => {
      // 在同一次用户手势中请求窗口聚焦与侧栏打开；API 不保证侧栏获得键盘焦点。
      const focusRequest = browser.windows.update(windowId, { focused: true });
      const panelRequest = requestTargetPanel(windowId);
      const [panelResult, focusResult] = await Promise.allSettled([panelRequest, focusRequest]);

      if (focusResult.status === 'rejected') {
        console.error('Could not focus window', focusResult.reason);
        setMessage({ key: 'focusFailed', urgent: true });
        return;
      }
      if (panelResult.status === 'rejected') {
        console.error('Could not open target panel', panelResult.reason);
        setMessage({ key: 'panelOpenFailed', urgent: true });
        return;
      }

      setMessage({ key: 'switchedWindow', urgent: false });
      await refreshLiveWindows();
    },
    [refreshLiveWindows, requestTargetPanel],
  );

  /**
   * 激活被点击的标签，并使其所属窗口置顶。
   *
   * @param tab 当前浏览器标签节点。
   */
  const activateTab = useCallback(
    async (tab: LiveTab): Promise<void> => {
      // 标签激活与窗口聚焦都是当前用户发起的轻量浏览器操作。
      const activationRequest = browser.tabs.update(tab.id, { active: true });
      const focusRequest = browser.windows.update(tab.windowId, { focused: true });
      const panelRequest = requestTargetPanel(tab.windowId);
      const [panelResult, activationResult, focusResult] = await Promise.allSettled([
        panelRequest,
        activationRequest,
        focusRequest,
      ]);

      if (activationResult.status === 'rejected') {
        console.error('Could not activate tab', activationResult.reason);
        setMessage({ key: 'activateFailed', urgent: true });
        return;
      }
      if (focusResult.status === 'rejected') {
        console.error('Could not focus activated tab window', focusResult.reason);
        setMessage({ key: 'activateFocusFailed', urgent: true });
        return;
      }
      if (panelResult.status === 'rejected') {
        console.error('Could not open activated tab panel', panelResult.reason);
        setMessage({ key: 'activatePanelFailed', urgent: true });
        return;
      }

      setMessage({ key: 'activated', params: { title: tab.title }, urgent: false });
      await refreshLiveWindows();
    },
    [refreshLiveWindows, requestTargetPanel],
  );

  // Edge 工具栏弹窗可能让所有普通窗口暂时报告失焦；此时沿用最近一次确认的窗口。
  const reportedFocusedWindowId = windows.find((liveWindow) => liveWindow.focused)?.id;
  const rememberedFocusedWindowId = windows.some(
    (liveWindow) => liveWindow.id === lastFocusedWindowId,
  )
    ? lastFocusedWindowId
    : null;
  const displayedFocusedWindowId =
    reportedFocusedWindowId ?? rememberedFocusedWindowId ?? panelWindowId;
  // 只有另一个普通窗口明确获得焦点，才收起本侧栏的所有实时窗口节点。
  const panelWindowFocused = panelWindowId !== null && displayedFocusedWindowId === panelWindowId;

  useEffect(() => {
    /**
     * 侧栏文档收到 Tab 时切换窗口，不要求焦点落在特定树节点上。
     *
     * @param event 当前 Side Panel 的原生键盘事件。
     */
    const onPanelKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        controlsMode ||
        event.key !== 'Tab' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }

      // 默认监听整个侧栏；编辑区域、菜单和对话框保留正常的 Tab 导航。
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          'textarea, select, input:not([type="checkbox"]), [contenteditable="true"], [role="dialog"], [role="menu"], [data-native-keyboard]',
        )
      )
        return;

      event.preventDefault();
      if (event.repeat) return;
      const targetId = adjacentWindowId(
        windows.map((liveWindow) => ({
          id: liveWindow.id,
          focused: liveWindow.id === displayedFocusedWindowId,
        })),
        event.shiftKey ? -1 : 1,
      );
      if (targetId === undefined) {
        setMessage({ key: 'needTwoWindows', urgent: true });
        return;
      }
      void switchToWindow(targetId);
    };

    document.addEventListener('keydown', onPanelKeyDown);
    return () => document.removeEventListener('keydown', onPanelKeyDown);
  }, [windows, switchToWindow, controlsMode, displayedFocusedWindowId]);

  /**
   * 切换当前窗口在 Side Panel 中的展开状态。
   *
   * @param liveWindow 被操作的实时窗口。
   * @param currentlyExpanded 当前侧栏实际展示的展开状态，避免焦点更新尚未到达时反向切换。
   */
  function toggleWindow(liveWindow: LiveWindow, currentlyExpanded: boolean): void {
    setExpandedWindows((previous) => ({
      ...previous,
      [liveWindow.id]: !currentlyExpanded,
    }));
  }

  /**
   * 切换当前标签组在 Side Panel 中的展开状态。
   *
   * @param group 被操作的实时标签组。
   */
  function toggleGroup(group: LiveGroup): void {
    setExpandedGroups((previous) => ({
      ...previous,
      [group.id]: !(previous[group.id] ?? true),
    }));
  }

  // 用结构化状态决定是否占用界面，不依赖任何特定语言的词句。
  const immediateStatuses = [message, storageMessage, snapshotMessage]
    .filter((value): value is Notice => value?.urgent === true)
    .map((value) => t(value.key, value.params));
  if (archiveWarning) immediateStatuses.push(translateDiagnostic(locale, archiveWarning));
  if (snapshotState?.errors.length)
    immediateStatuses.push(
      t('updateFailed', {
        errors: snapshotState.errors
          .map((error) => translateDiagnostic(locale, error))
          .join(locale === 'zh-CN' ? '；' : '; '),
      }),
    );

  return (
    <main className="panel">
      <h1 className="visually-hidden">TabStash</h1>
      {immediateStatuses.length ? (
        <output aria-live="polite" className="status status-immediate">
          {immediateStatuses.join(' · ')}
        </output>
      ) : null}

      <section aria-labelledby="window-heading" className="window-section">
        <div className="section-heading">
          <h2 id="window-heading">{t('currentWindows')}</h2>
          <div className="section-actions">
            <span className="section-count">{windows.length}</span>
            <button
              className="refresh-button"
              onClick={() => {
                void refreshLiveWindows();
                void refreshStorageStatus();
                void refreshSnapshotStatus(true);
                void refreshArchives();
              }}
              type="button"
            >
              {t('refresh')}
            </button>
          </div>
        </div>
        <div className="window-list" ref={treeRef}>
          {windows.length === 0 ? (
            <p className="empty-state">{t('noWindows')}</p>
          ) : (
            windows.map((liveWindow, index) => {
              const windowExpanded =
                panelWindowFocused &&
                (expandedWindows[liveWindow.id] ?? liveWindow.id === displayedFocusedWindowId);
              return (
                <div className="window-block" key={liveWindow.id}>
                  <div
                    className={`window-row${liveWindow.id === displayedFocusedWindowId ? ' focused' : ''}`}
                  >
                    <button
                      aria-expanded={windowExpanded}
                      aria-label={t(windowExpanded ? 'collapseWindow' : 'expandWindow', {
                        index: index + 1,
                      })}
                      className="disclosure-button"
                      data-tree-toggle="true"
                      data-tree-owner={`window-${liveWindow.id}`}
                      onClick={() => toggleWindow(liveWindow, windowExpanded)}
                      type="button"
                    >
                      {windowExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <button
                      aria-label={t('switchWindow', {
                        index: index + 1,
                        count: liveWindow.tabCount,
                      })}
                      aria-expanded={windowExpanded}
                      className="window-target"
                      data-tree-node={`window-${liveWindow.id}`}
                      onClick={() => {
                        void switchToWindow(liveWindow.id);
                      }}
                      type="button"
                    >
                      <span aria-hidden="true" className="window-marker" />
                      <span className="window-copy">
                        <strong>{t('window', { index: index + 1 })}</strong>
                        <small title={liveWindow.activeTabTitle || t('currentTabUntitled')}>
                          {liveWindow.activeTabTitle || t('currentTabUntitled')}
                        </small>
                      </span>
                      <span className="tab-count">{liveWindow.tabCount}</span>
                    </button>
                    <ArchiveActions
                      busy={busyWindows.has(liveWindow.id)}
                      onArchive={(close) => {
                        void archiveWindow(liveWindow.id, close);
                      }}
                    />
                  </div>

                  {windowExpanded ? (
                    <div className="window-children">
                      {liveWindow.nodes.map((node) => {
                        if (node.kind === 'tab') {
                          return (
                            <TabRow
                              grouped={false}
                              key={`tab-${node.id}`}
                              onActivate={activateTab}
                              parentKey={`window-${liveWindow.id}`}
                              tab={node}
                            />
                          );
                        }

                        const groupExpanded = expandedGroups[node.id] ?? true;
                        return (
                          <div className="group-block" key={`group-${node.id}`}>
                            <button
                              aria-expanded={groupExpanded}
                              aria-label={t(groupExpanded ? 'collapseGroup' : 'expandGroup', {
                                title: node.title || t('untitledGroup'),
                              })}
                              className="group-row"
                              data-tree-node={`group-${node.id}`}
                              data-tree-parent={`window-${liveWindow.id}`}
                              onClick={() => toggleGroup(node)}
                              type="button"
                            >
                              {groupExpanded ? (
                                <ChevronDown size={14} />
                              ) : (
                                <ChevronRight size={14} />
                              )}
                              <span aria-hidden="true" className={`group-dot ${node.color}`} />
                              <span className="node-title">{node.title || t('untitledGroup')}</span>
                              <span className="tab-count">{node.tabs.length}</span>
                            </button>
                            {groupExpanded ? (
                              <div className="group-children">
                                {node.tabs.map((tab) => (
                                  <TabRow
                                    grouped
                                    key={tab.id}
                                    onActivate={activateTab}
                                    parentKey={`group-${node.id}`}
                                    tab={tab}
                                  />
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </section>

      <ArchiveList
        archives={archivedWindows}
        error={archiveError ? translateDiagnostic(locale, archiveError) : ''}
      />
      <section aria-labelledby="settings-heading" className="settings-section" data-native-keyboard>
        <h2 id="settings-heading">{t('settings')}</h2>
        <SettingSwitch
          buttonRef={controlsRef}
          checked={openTargetPanel}
          label={t('openTargetPanel')}
          onCheckedChange={setOpenTargetPanel}
        />
        <AutoArchiveControl />
        <div className="appearance-setting-row">
          <span>{t('appearance')}</span>
          <AppearanceControl />
        </div>
        <div className="appearance-setting-row">
          <span>{t('language')}</span>
          <LanguageControl />
        </div>
      </section>
    </main>
  );
}
