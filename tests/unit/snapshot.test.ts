import { describe, expect, it, vi } from 'vitest';
import { type CaptureReader, captureWindow } from '../../src/application/live-state/capture-window';
import {
  buildWindowSnapshot,
  computeSnapshotHash,
  type SnapshotSource,
} from '../../src/domain/archive/snapshot';
import type { SourceGroup } from '../../src/domain/window/live-tree';

/** 构造同时包含分组、未分组和置顶标签的源窗口，保留全部窗口属性。 */
function source(): SnapshotSource {
  return {
    id: 50,
    focused: true,
    state: 'maximized',
    left: 10,
    top: 20,
    width: 900,
    height: 700,
    tabs: [
      {
        id: 11,
        windowId: 50,
        groupId: 9,
        index: 1,
        title: '资料',
        url: 'https://example.com/a',
        favIconUrl: 'https://example.com/icon.png',
        pinned: false,
        active: true,
      },
      {
        id: 10,
        windowId: 50,
        groupId: -1,
        index: 0,
        title: '首页',
        url: 'https://example.com',
        favIconUrl: null,
        pinned: true,
        active: false,
      },
    ],
  };
}
const groups: SourceGroup[] = [
  { id: 9, windowId: 50, title: '工作', color: 'blue', collapsed: true },
];

describe('窗口快照与去重 hash', () => {
  it('保存顺序、活动标签、分组与几何信息，运行时 ID 不进入快照', () => {
    let nextKey = 0;
    const snapshot = buildWindowSnapshot(source(), groups, () => `key-${++nextKey}`);
    expect(snapshot).toEqual({
      state: 'maximized',
      left: 10,
      top: 20,
      width: 900,
      height: 700,
      activeTabKey: 'key-3',
      groups: [{ key: 'key-2', title: '工作', color: 'blue', collapsed: true }],
      tabs: [
        { key: 'key-1', index: 0, title: '首页', url: 'https://example.com', pinned: true },
        {
          key: 'key-3',
          index: 1,
          title: '资料',
          url: 'https://example.com/a',
          pinned: false,
          groupKey: 'key-2',
          favIconUrl: 'https://example.com/icon.png',
        },
      ],
    });
    expect(source().tabs[0]?.id).toBe(11);
  });

  it('随机标识、运行时 ID、标题、图标、活动标签和窗口位置不影响 hash', async () => {
    const original = buildWindowSnapshot(source(), groups);
    const changedSource = source();
    changedSource.id = 60;
    changedSource.left = 800;
    changedSource.tabs = changedSource.tabs.map((tab) => ({
      ...tab,
      id: tab.id + 100,
      windowId: 60,
      groupId: tab.groupId === 9 ? 90 : -1,
      title: '新标题',
      favIconUrl: null,
      active: !tab.active,
    }));
    const changed = buildWindowSnapshot(
      changedSource,
      groups.map((group) => ({ ...group, id: 90, windowId: 60 })),
    );
    expect(await computeSnapshotHash(changed)).toBe(await computeSnapshotHash(original));
  });

  it.each(['url', 'order', 'pinned', 'membership', 'title', 'color', 'collapsed'])(
    '%s 变化会改变去重 hash',
    async (field) => {
      const original = buildWindowSnapshot(source(), groups);
      const changed = structuredClone(original);
      const first = changed.tabs[0];
      const second = changed.tabs[1];
      const group = changed.groups[0];
      if (!first || !second || !group) throw new Error('快照测试数据不完整');
      if (field === 'url') first.url = 'https://example.net';
      if (field === 'order') {
        first.index = 1;
        second.index = 0;
      }
      if (field === 'pinned') first.pinned = false;
      if (field === 'membership') delete second.groupKey;
      if (field === 'title') group.title = '另一组';
      if (field === 'color') group.color = 'red';
      if (field === 'collapsed') group.collapsed = false;
      expect(await computeSnapshotHash(changed)).not.toBe(await computeSnapshotHash(original));
    },
  );

  it('缺少 URL 保留 null；组信息缺失和空窗口拒绝生成残缺快照', () => {
    const input = source();
    input.tabs = input.tabs.map((tab) => ({ ...tab, url: null }));
    expect(buildWindowSnapshot(input, groups).tabs.every((tab) => tab.url === null)).toBe(true);
    expect(() => buildWindowSnapshot(input, [])).toThrow('标签组');
    expect(() => buildWindowSnapshot({ ...input, tabs: [] }, groups)).toThrow('没有可捕获');
  });

  it('捕获时窗口变化会重试，连续变化则返回失败', async () => {
    const changed = { ...source(), left: 300 };
    const readWindow = vi.fn().mockResolvedValue(changed).mockResolvedValueOnce(source());
    const reader: CaptureReader = { readWindow, readGroups: async () => groups };
    expect((await captureWindow(50, reader)).left).toBe(300);
    expect(readWindow).toHaveBeenCalledTimes(4);
    let tick = 0;
    reader.readWindow = async () => ({ ...source(), left: tick++ });
    await expect(captureWindow(50, reader)).rejects.toThrow('稳定快照');
  });

  it('组元数据变化也会重试，浏览器读取错误不会伪装成空快照', async () => {
    let tick = 0;
    const reader: CaptureReader = {
      readWindow: async () => source(),
      readGroups: async () => groups.map((group) => ({ ...group, title: String(tick++) })),
    };
    await expect(captureWindow(50, reader)).rejects.toThrow('稳定快照');
    reader.readWindow = async () => {
      throw new Error('窗口已关闭');
    };
    await expect(captureWindow(50, reader)).rejects.toThrow('窗口已关闭');
  });
});
