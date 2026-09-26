import { browser } from 'wxt/browser';
import {
  buildLiveTree,
  type GroupColor,
  type LiveWindow,
  type SourceGroup,
  type SourceWindow,
} from '../../domain/window/live-tree';

/**
 * 以浏览器实时状态为准，读取普通窗口、标签及标签组并构建面板树。
 *
 * 运行时 ID 只用于当前侧栏操作。浏览器关闭后这些 ID 不应进入归档模型。
 * 某些刚创建的标签可能尚无 ID 或 URL；无 ID 的标签暂时跳过，后续事件
 * 会触发重新查询，不在 React 中长期维护一份浏览器状态副本。
 *
 * @returns 当前普通窗口的完整层级数据。
 */
export async function readLiveWindows(): Promise<LiveWindow[]> {
  const [windows, groups] = await Promise.all([
    browser.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    browser.tabGroups.query({}),
  ]);

  const sourceWindows: SourceWindow[] = windows.flatMap((window) => {
    const windowId = window.id;
    if (windowId === undefined) {
      return [];
    }

    const tabs = (window.tabs ?? []).flatMap((tab) => {
      if (tab.id === undefined) {
        return [];
      }

      return [
        {
          id: tab.id,
          windowId,
          groupId: tab.groupId ?? -1,
          index: tab.index,
          title: tab.title ?? null,
          url: tab.url ?? tab.pendingUrl ?? null,
          favIconUrl: tab.favIconUrl ?? null,
          active: tab.active,
          pinned: tab.pinned,
        },
      ];
    });

    return [{ id: windowId, focused: window.focused ?? false, tabs }];
  });

  const sourceGroups: SourceGroup[] = groups.map((group) => ({
    id: group.id,
    windowId: group.windowId,
    title: group.title ?? null,
    color: group.color as GroupColor,
    collapsed: group.collapsed,
  }));

  return buildLiveTree(sourceWindows, sourceGroups);
}
