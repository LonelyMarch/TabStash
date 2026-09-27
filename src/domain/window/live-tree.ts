/** Chromium 标签组可用的颜色，供实时树展示使用。 */
export type GroupColor =
  | 'grey'
  | 'blue'
  | 'red'
  | 'yellow'
  | 'green'
  | 'pink'
  | 'purple'
  | 'cyan'
  | 'orange';

/** 从浏览器 API 读取并完成必要字段归一化后的标签。 */
export interface SourceTab {
  id: number;
  windowId: number;
  groupId: number;
  index: number;
  title: string | null;
  url: string | null;
  favIconUrl: string | null;
  active: boolean;
  pinned: boolean;
}

/** 从浏览器 API 读取的普通窗口。 */
export interface SourceWindow {
  id: number;
  focused: boolean;
  tabs: SourceTab[];
}

/** 从浏览器 API 读取的标签组元数据。 */
export interface SourceGroup {
  id: number;
  windowId: number;
  title: string | null;
  color: GroupColor;
  collapsed: boolean;
}

/** 面板可直接展示与激活的实时标签节点。 */
export interface LiveTab {
  kind: 'tab';
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string | null;
  favIconUrl: string | null;
  active: boolean;
  pinned: boolean;
}

/** 面板可展开的实时标签组节点。 */
export interface LiveGroup {
  kind: 'group';
  id: number;
  windowId: number;
  title: string;
  color: GroupColor;
  browserCollapsed: boolean;
  tabs: LiveTab[];
}

export type LiveNode = LiveTab | LiveGroup;

/** 当前普通浏览器窗口的实时树。 */
export interface LiveWindow {
  id: number;
  focused: boolean;
  tabCount: number;
  activeTabTitle: string;
  nodes: LiveNode[];
}

/**
 * 根据浏览器原始顺序构造 Window → Group → Tab 实时树。
 *
 * 分组节点放在该组首个标签的原始 index 处，后续同组标签只追加到组内。
 * 如果某个标签的组元数据因浏览器事件竞态暂时缺失，该标签会作为未分组
 * 节点显示，避免从界面中消失；下一次浏览器失效通知会重新查询并纠正。
 *
 * @param windows 浏览器当前普通窗口与标签数据。
 * @param groups 浏览器当前标签组元数据。
 * @returns 按窗口 ID 排序、保留标签原始顺序的实时树。
 */
export function buildLiveTree(
  windows: readonly SourceWindow[],
  groups: readonly SourceGroup[],
): LiveWindow[] {
  const groupsById = new Map(groups.map((group) => [group.id, group]));

  return windows
    .map((window): LiveWindow => {
      const nodes: LiveNode[] = [];
      const createdGroups = new Map<number, LiveGroup>();
      let activeTabTitle = '';

      // 先复制再排序，保证传入的浏览器数据不被纯转换函数修改。
      const orderedTabs = [...window.tabs].sort((left, right) => left.index - right.index);
      for (const tab of orderedTabs) {
        const title = tab.title?.trim() || tab.url?.trim() || '';
        const liveTab: LiveTab = {
          kind: 'tab',
          id: tab.id,
          windowId: window.id,
          index: tab.index,
          title,
          url: tab.url,
          favIconUrl: tab.favIconUrl,
          active: tab.active,
          pinned: tab.pinned,
        };

        if (tab.active) {
          activeTabTitle = title;
        }

        const sourceGroup = tab.groupId >= 0 ? groupsById.get(tab.groupId) : undefined;
        if (sourceGroup === undefined || sourceGroup.windowId !== window.id) {
          nodes.push(liveTab);
          continue;
        }

        let liveGroup = createdGroups.get(sourceGroup.id);
        if (liveGroup === undefined) {
          liveGroup = {
            kind: 'group',
            id: sourceGroup.id,
            windowId: window.id,
            title: sourceGroup.title?.trim() || '',
            color: sourceGroup.color,
            browserCollapsed: sourceGroup.collapsed,
            tabs: [],
          };
          createdGroups.set(sourceGroup.id, liveGroup);
          nodes.push(liveGroup);
        }
        liveGroup.tabs.push(liveTab);
      }

      return {
        id: window.id,
        focused: window.focused,
        tabCount: orderedTabs.length,
        activeTabTitle,
        nodes,
      };
    })
    .sort((left, right) => left.id - right.id);
}
