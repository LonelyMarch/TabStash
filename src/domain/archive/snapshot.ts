import type { SourceGroup, SourceWindow } from '../window/live-tree';
import type { GroupSnapshot, WindowSnapshot } from './models';

/** 捕获窗口时除标签外需要保留的尺寸、位置与状态。 */
export interface SnapshotSource extends SourceWindow {
  state?: WindowSnapshot['state'];
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/**
 * 将浏览器窗口转换为独立快照，运行时 ID 仅用于本次关联，不进入返回对象。
 *
 * @param source 已读取的完整普通窗口。
 * @param groups 同一次捕获所需的组元数据。
 * @param createKey 快照内标识生成器，测试可注入确定性实现。
 * @returns 可持久化的窗口快照；空窗口或缺失组信息时拒绝生成残缺结果。
 */
export function buildWindowSnapshot(
  source: SnapshotSource,
  groups: readonly SourceGroup[],
  createKey: () => string = () => crypto.randomUUID(),
): WindowSnapshot {
  if (source.tabs.length === 0) throw new Error('窗口没有可捕获的标签');
  const snapshot: WindowSnapshot = { tabs: [], groups: [] };
  for (const field of ['left', 'top', 'width', 'height'] as const) {
    const value = source[field];
    if (value !== undefined) snapshot[field] = value;
  }
  if (source.state !== undefined) snapshot.state = source.state;
  const groupKeys = new Map<number, string>();
  const metadata = new Map(
    groups.filter((group) => group.windowId === source.id).map((group) => [group.id, group]),
  );
  for (const tab of [...source.tabs].sort((a, b) => a.index - b.index)) {
    let groupKey: string | undefined;
    if (tab.groupId >= 0) {
      groupKey = groupKeys.get(tab.groupId);
      if (groupKey === undefined) {
        const group = metadata.get(tab.groupId);
        // 实时树可以暂时展示未分组标签；持久快照不允许静默丢失真实组关系。
        if (!group) throw new Error('捕获时标签组发生变化，请重试');
        groupKey = createKey();
        groupKeys.set(group.id, groupKey);
        snapshot.groups.push({
          key: groupKey,
          title: group.title ?? '',
          color: group.color,
          collapsed: group.collapsed,
        });
      }
    }
    const key = createKey();
    snapshot.tabs.push({
      key,
      url: tab.url,
      title: tab.title ?? '',
      index: tab.index,
      pinned: tab.pinned,
      ...(tab.favIconUrl === null ? {} : { favIconUrl: tab.favIconUrl }),
      ...(groupKey === undefined ? {} : { groupKey }),
    });
    if (tab.active) snapshot.activeTabKey = key;
  }
  return snapshot;
}

/**
 * 生成稳定的去重输入，用组首次出现的位置替代随机 key。
 *
 * @param snapshot 完整窗口快照。
 * @returns 包含顺序、URL、置顶、组关系与组属性的规范 JSON。
 */
export function canonicalSnapshot(snapshot: WindowSnapshot): string {
  const metadata = new Map(snapshot.groups.map((group) => [group.key, group]));
  const groupIndices = new Map<string, number>();
  const groups: Omit<GroupSnapshot, 'key'>[] = [];
  const tabs = [...snapshot.tabs]
    .sort((a, b) => a.index - b.index)
    .map((tab) => {
      let groupIndex: number | null = null;
      if (tab.groupKey !== undefined) {
        const group = metadata.get(tab.groupKey);
        if (!group) throw new Error('快照中的标签组引用无效');
        const existing = groupIndices.get(tab.groupKey);
        if (existing === undefined) {
          groupIndex = groups.length;
          groupIndices.set(tab.groupKey, groupIndex);
          groups.push({ title: group.title ?? '', color: group.color, collapsed: group.collapsed });
        } else groupIndex = existing;
      }
      // 标题、图标、活动标签和窗口位置不影响“手动归档后立即关闭”的去重。
      return { url: tab.url, pinned: tab.pinned, group: groupIndex };
    });
  return JSON.stringify({ version: 1, tabs, groups });
}

/**
 * 使用 SHA-256 计算去重 hash；版本前缀便于未来调整规则时区分旧数据。
 *
 * @param snapshot 已规范化的窗口快照。
 * @returns 与随机标识、运行时 ID 和归档时间无关的 hash。
 */
export async function computeSnapshotHash(snapshot: WindowSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSnapshot(snapshot));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `v1:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')}`;
}
