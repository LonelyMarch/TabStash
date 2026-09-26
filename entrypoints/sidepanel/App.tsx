import { ChevronDown, ChevronRight, Pin } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { ArchiveCommand, ArchivedWindow } from '../../src/domain/archive/models';
import { adjacentWindowId } from '../../src/domain/window/adjacent-window';
import type { LiveGroup, LiveTab, LiveWindow } from '../../src/domain/window/live-tree';
import { onMessage, sendMessage } from '../../src/infrastructure/messaging/protocol';
import { ArchiveActions } from '../../src/ui/ArchiveActions';
import { ArchiveList } from '../../src/ui/ArchiveList';
import { AutoArchiveControl } from '../../src/ui/AutoArchiveControl';
import { AppearanceControl } from '../../src/ui/appearance/AppearanceControl';
import { SettingSwitch } from '../../src/ui/controls/SettingSwitch';
import { TabIcon } from '../../src/ui/TabIcon';
import { useTreeKeyboard } from '../../src/ui/use-tree-keyboard';

/**
 * 将未知的浏览器 API 或消息错误转换为可显示的文本。
 *
 * @param error 浏览器 API 或 Background 抛出的值。
 * @returns 便于用户反馈的错误描述。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  return (
    <button
      aria-current={tab.active ? 'page' : undefined}
      aria-label={`${tab.title}${tab.pinned ? '，已固定' : ''}`}
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
        title={tab.title}
        url={tab.url}
      />
      <span className="node-title">{tab.title}</span>
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
  const [windows, setWindows] = useState<LiveWindow[]>([]);
  const [panelWindowId, setPanelWindowId] = useState<number | null>(null);
  const [lastFocusedWindowId, setLastFocusedWindowId] = useState<number | null>(null);
  const [openTargetPanel, setOpenTargetPanel] = useState(true);
  const [expandedWindows, setExpandedWindows] = useState<Record<number, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<number, boolean>>({});
  const [message, setMessage] = useState('正在读取浏览器窗口…');
  const [storageMessage, setStorageMessage] = useState('正在检查本地存储…');
  const [snapshotMessage, setSnapshotMessage] = useState('正在保存窗口快照…');
  const snapshotGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const storageGeneration = useRef(0);
  const { treeRef, controlsRef, controlsMode } = useTreeKeyboard();
  const [archivedWindows, setArchivedWindows] = useState<ArchivedWindow[]>([]);
  const [archiveError, setArchiveError] = useState('正在读取归档…');
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
        if (mounted) setMessage(`无法识别侧栏所在窗口：${describeError(error)}`);
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
        timer = setTimeout(() => reject(new Error('归档列表读取超时，请刷新重试')), 8000);
      });
      const data = await Promise.race([sendMessage('getArchives'), timeout]);
      if (generation !== archiveGeneration.current) return;
      setArchivedWindows(data);
      setArchiveError('');
    } catch (error: unknown) {
      if (generation === archiveGeneration.current)
        setArchiveError(`归档读取失败：${describeError(error)}`);
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
        timer = setTimeout(() => reject(new Error('快照检查超时，请点击刷新重试')), 8000);
      });
      const status = await Promise.race([
        recapture ? sendMessage('refreshSnapshots') : sendMessage('getSnapshotStatus'),
        timeout,
      ]);
      if (generation !== snapshotGeneration.current) return;
      const savedAt =
        status.latestSavedAt === null
          ? ''
          : ` · 最近保存 ${new Date(status.latestSavedAt).toLocaleTimeString()}`;
      setSnapshotMessage(
        `窗口快照 ${status.savedWindowCount}/${status.windowCount}${savedAt}${status.errors.length ? ` · 更新失败：${status.errors.join('；')}` : ''}`,
      );
    } catch (error: unknown) {
      if (generation === snapshotGeneration.current)
        setSnapshotMessage(`窗口快照未就绪：${describeError(error)}`);
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
        timeoutId = setTimeout(() => reject(new Error('存储检查超时，请点击刷新重试')), 8000);
      });
      const status = await Promise.race([sendMessage('getPersistenceStatus'), timeout]);
      if (generation !== storageGeneration.current) return;
      setStorageMessage(
        `本地存储就绪 · ${status.archiveCount} 个归档${status.pendingOperationCount ? ` · ${status.pendingOperationCount} 个操作待核对` : ''}`,
      );
    } catch (error: unknown) {
      if (generation === storageGeneration.current) {
        setStorageMessage(`本地存储不可用：${describeError(error)}`);
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
      setMessage('上次归档结果尚未确认，请先点击原操作按钮重试。');
      return;
    }
    const command = previous ?? { requestId: crypto.randomUUID(), windowId, closeAfterArchive };
    pendingArchives.current.set(windowId, command);
    activeArchives.current.add(windowId);
    setBusyWindows(new Set(activeArchives.current));
    // 忙碌状态由窗口行按钮展示；不要在列表上方临时插入状态块，以免整栏跳动。
    setMessage('');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('归档结果等待超时，可用同一按钮重试查询')),
          15000,
        );
      });
      const result = await Promise.race([sendMessage('archiveWindow', command), timeout]);
      pendingArchives.current.delete(windowId);
      setMessage(
        result.warning ??
          (result.outcome === 'closed' ? '已归档并关闭窗口。' : '已归档，原窗口保持打开。'),
      );
      void refreshArchives();
      void refreshStorageStatus();
    } catch (error: unknown) {
      setMessage(`归档请求未完成确认：${describeError(error)}`);
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
          reject(new Error('Background 在 8 秒内没有返回窗口数据，请重新加载扩展后重试'));
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
        previous === '正在读取浏览器窗口…'
          ? `已读取 ${latestWindows.length} 个普通窗口。`
          : previous,
      );
    } catch (error: unknown) {
      if (generation === refreshGeneration.current) {
        setMessage(`读取窗口失败：${describeError(error)}`);
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
        setMessage(`聚焦窗口失败：${describeError(focusResult.reason)}`);
        return;
      }
      if (panelResult.status === 'rejected') {
        setMessage(`窗口已聚焦，但打开侧栏失败：${describeError(panelResult.reason)}`);
        return;
      }

      setMessage('已切换窗口。');
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
        setMessage(`激活标签失败：${describeError(activationResult.reason)}`);
        return;
      }
      if (focusResult.status === 'rejected') {
        setMessage(`标签已激活，但聚焦窗口失败：${describeError(focusResult.reason)}`);
        return;
      }
      if (panelResult.status === 'rejected') {
        setMessage(`标签已激活，但打开侧栏失败：${describeError(panelResult.reason)}`);
        return;
      }

      setMessage(`已激活：${tab.title}`);
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
        setMessage('至少需要两个普通窗口才能切换。');
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

  // 常规诊断信息不占用界面；错误和进行中操作仍在窗口树前直接显示。
  const immediateStatuses = [message, storageMessage, snapshotMessage].filter((value) =>
    /失败|未就绪|不可用|超时|未完成|未确认|需核对|正在/.test(value),
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
          <h2 id="window-heading">当前窗口</h2>
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
              刷新
            </button>
          </div>
        </div>
        <div className="window-list" ref={treeRef}>
          {windows.length === 0 ? (
            <p className="empty-state">未读取到普通窗口。</p>
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
                      aria-label={`${windowExpanded ? '折叠' : '展开'}窗口 ${index + 1}`}
                      className="disclosure-button"
                      data-tree-toggle="true"
                      data-tree-owner={`window-${liveWindow.id}`}
                      onClick={() => toggleWindow(liveWindow, windowExpanded)}
                      type="button"
                    >
                      {windowExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <button
                      aria-label={`切换到窗口 ${index + 1}，${liveWindow.tabCount} 个标签页`}
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
                        <strong>窗口 {index + 1}</strong>
                        <small title={liveWindow.activeTabTitle}>{liveWindow.activeTabTitle}</small>
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
                              aria-label={`${groupExpanded ? '折叠' : '展开'}标签组 ${node.title}`}
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
                              <span className="node-title">{node.title}</span>
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

      <ArchiveList archives={archivedWindows} error={archiveError} />
      <section aria-labelledby="settings-heading" className="settings-section" data-native-keyboard>
        <h2 id="settings-heading">设置</h2>
        <SettingSwitch
          buttonRef={controlsRef}
          checked={openTargetPanel}
          label="切换时打开目标窗口侧栏"
          onCheckedChange={setOpenTargetPanel}
        />
        <AutoArchiveControl />
        <div className="appearance-setting-row">
          <span>外观</span>
          <AppearanceControl />
        </div>
      </section>
    </main>
  );
}
