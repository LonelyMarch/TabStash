import { browser } from 'wxt/browser';
import type { CaptureReader } from '../../application/live-state/capture-window';

/** 从浏览器读取捕获字段；不在模块导入时访问浏览器状态。 */
export const snapshotReader: CaptureReader = {
  /** @param windowId 要读取的普通窗口，不接收关闭中或无标签的窗口。 */
  async readWindow(windowId) {
    const window = await browser.windows.get(windowId, { populate: true });
    if (window.type !== 'normal' || window.incognito || window.id === undefined) {
      throw new Error('只捕获普通的非隐私窗口');
    }
    if (window.state === 'locked-fullscreen') throw new Error('不支持捕获锁定全屏窗口');
    const tabs = window.tabs ?? [];
    if (tabs.some((tab) => tab.id === undefined)) throw new Error('窗口标签信息尚未完整');
    return {
      id: window.id,
      focused: window.focused,
      ...(window.state === undefined ? {} : { state: window.state }),
      ...(window.left === undefined ? {} : { left: window.left }),
      ...(window.top === undefined ? {} : { top: window.top }),
      ...(window.width === undefined ? {} : { width: window.width }),
      ...(window.height === undefined ? {} : { height: window.height }),
      tabs: tabs.map((tab) => ({
        id: tab.id as number,
        windowId,
        groupId: tab.groupId ?? -1,
        index: tab.index,
        title: tab.title ?? null,
        url: tab.pendingUrl ?? tab.url ?? null,
        favIconUrl: tab.favIconUrl ?? null,
        active: tab.active,
        pinned: tab.pinned,
      })),
    };
  },
  /** @param windowId 查询该窗口的组，避免跨窗口元数据混用。 */
  async readGroups(windowId) {
    return (await browser.tabGroups.query({ windowId })).map((group) => ({
      id: group.id,
      windowId: group.windowId,
      title: group.title ?? null,
      color: group.color,
      collapsed: group.collapsed,
    }));
  },
};
