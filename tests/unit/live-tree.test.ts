import { describe, expect, it } from 'vitest';
import {
  buildLiveTree,
  type SourceGroup,
  type SourceTab,
  type SourceWindow,
} from '../../src/domain/window/live-tree';

/** 为树结构测试创建只改变必要字段的浏览器标签数据。 */
function sourceTab(index: number, groupId: number, id = index + 100): SourceTab {
  return {
    id,
    windowId: 10,
    groupId,
    index,
    title: `标签 ${index}`,
    url: `https://example.com/${index}`,
    favIconUrl: null,
    active: index === 2,
    pinned: index === 0,
  };
}

/**
 * 验证组节点位置、未分组标签及事件竞态兜底行为。
 *
 * 这些情况直接影响用户看到的标签是否完整、是否按浏览器原始顺序出现。
 */
describe('buildLiveTree', () => {
  it('按首个组成员的位置插入组，并保留未分组标签的相对顺序', () => {
    const windows: SourceWindow[] = [
      {
        id: 10,
        focused: true,
        tabs: [sourceTab(3, -1), sourceTab(1, 7), sourceTab(0, -1), sourceTab(2, 7)],
      },
    ];
    const groups: SourceGroup[] = [
      {
        id: 7,
        windowId: 10,
        title: '项目',
        color: 'blue',
        collapsed: false,
      },
    ];

    const [window] = buildLiveTree(windows, groups);
    expect(window?.nodes.map((node) => `${node.kind}:${node.id}`)).toEqual([
      'tab:100',
      'group:7',
      'tab:103',
    ]);
    const group = window?.nodes[1];
    expect(group?.kind).toBe('group');
    if (group?.kind === 'group') {
      expect(group.tabs.map((tab) => tab.index)).toEqual([1, 2]);
      expect(group.title).toBe('项目');
    }
    expect(window?.activeTabTitle).toBe('标签 2');
  });

  it('组元数据尚未到达时仍直接显示标签', () => {
    const windows: SourceWindow[] = [
      {
        id: 10,
        focused: false,
        tabs: [sourceTab(0, 999)],
      },
    ];

    expect(buildLiveTree(windows, [])[0]?.nodes[0]?.kind).toBe('tab');
  });
});
