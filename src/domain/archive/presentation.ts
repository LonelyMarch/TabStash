import type { ArchivedWindow, WindowSnapshot } from './models';

/**
 * 按活动标签标题、首个有效标题、主机名、默认文案生成归档名称。
 * @param snapshot 已保存的快照，不读取当前浏览器状态。
 */
export function archiveTitle(snapshot: WindowSnapshot): string {
  const activeTitle = snapshot.tabs.find((tab) => tab.key === snapshot.activeTabKey)?.title.trim();
  if (activeTitle) return activeTitle;
  const tabs = [...snapshot.tabs].sort((a, b) => a.index - b.index);
  for (const tab of tabs) if (tab.title.trim()) return tab.title.trim();
  for (const tab of tabs) {
    try {
      const hostname = new URL(tab.url ?? '').hostname;
      if (hostname) return hostname;
    } catch {
      /* 内部页或缺失 URL 没有主机名，继续检查下一项。 */
    }
  }
  return '已归档窗口';
}

/**
 * 置顶归档优先显示，同一置顶状态内均按归档创建时间倒序排列。
 * @param archives 归档集合；返回新数组，不改变输入顺序。
 */
export function sortArchives(archives: readonly ArchivedWindow[]): ArchivedWindow[] {
  return [...archives].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      // 置顶操作时间不参与排序，避免较早创建的归档因后置顶而排到前面。
      b.archivedAt - a.archivedAt ||
      a.id.localeCompare(b.id),
  );
}
