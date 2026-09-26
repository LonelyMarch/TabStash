import type { RuntimeTabIdentity, WindowSnapshot } from '../../domain/archive/models';
import { buildWindowSnapshot, type SnapshotSource } from '../../domain/archive/snapshot';
import type { SourceGroup } from '../../domain/window/live-tree';

/** 捕获所需的浏览器读取接口；测试可模拟组变动、窗口关闭及 API 错误。 */
export interface CaptureReader {
  readWindow(windowId: number): Promise<SnapshotSource>;
  readGroups(windowId: number): Promise<SourceGroup[]>;
}

/**
 * 双读窗口与组并核对，避免标签移动途中保存混合状态；最多重试两次。
 *
 * 浏览器没有事务式快照 API，连续两次结果相同也不保证之后不会立即变化。
 * 无法获得稳定结果时抛错，由调用方保留最近一次成功持久化的窗口影子。
 *
 * @param windowId 普通窗口运行时 ID。
 * @param reader 浏览器读取适配器。
 * @returns 完整快照，不静默丢弃组或未读取到 URL 的标签。
 */
export async function captureWindowWithRuntimeTabs(
  windowId: number,
  reader: CaptureReader,
): Promise<{ snapshot: WindowSnapshot; runtimeTabs: RuntimeTabIdentity[] }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await reader.readWindow(windowId);
    const groupsBefore = await reader.readGroups(windowId);
    const after = await reader.readWindow(windowId);
    const groupsAfter = await reader.readGroups(windowId);
    // 组查询的返回顺序无语义；排序后再比较，避免因排列变化误判并重试。
    const orderedGroups = (groups: SourceGroup[]) => [...groups].sort((a, b) => a.id - b.id);
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(orderedGroups(groupsBefore)) !== JSON.stringify(orderedGroups(groupsAfter))
    )
      continue;
    try {
      const snapshot = buildWindowSnapshot(after, groupsAfter);
      // 快照构造器按 index 排序；只在实时影子中保留同一顺序的运行时 ID。
      const ordered = [...after.tabs].sort((a, b) => a.index - b.index);
      const runtimeTabs = snapshot.tabs.map((tab, index) => ({
        key: tab.key,
        tabId: ordered[index]?.id ?? -1,
      }));
      if (runtimeTabs.some((entry) => entry.tabId < 0)) throw new Error('标签 ID 映射不完整');
      return { snapshot, runtimeTabs };
    } catch (error: unknown) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error('窗口正在变化，尚未获得稳定快照');
}

/**
 * 兼容只需持久快照的调用者；运行时 ID 不进入普通归档数据。
 * @param windowId 要捕获的普通窗口。
 * @param reader 浏览器读取适配器。
 */
export async function captureWindow(
  windowId: number,
  reader: CaptureReader,
): Promise<WindowSnapshot> {
  return (await captureWindowWithRuntimeTabs(windowId, reader)).snapshot;
}
