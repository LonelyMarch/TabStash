import { describe, expect, it } from 'vitest';
import type { ArchivedWindow, WindowSnapshot } from '../../src/domain/archive/models';
import { archiveTitle, sortArchives } from '../../src/domain/archive/presentation';

describe('归档标题与排序', () => {
  it('标题按活动标签、首个标题、主机名与默认值回退', () => {
    const snapshot: WindowSnapshot = {
      groups: [],
      activeTabKey: 'b',
      tabs: [
        { key: 'a', title: '首页', url: 'https://example.com', index: 0, pinned: false },
        { key: 'b', title: '  当前  ', url: null, index: 1, pinned: false },
      ],
    };
    expect(archiveTitle(snapshot)).toBe('当前');
    snapshot.activeTabKey = 'missing';
    expect(archiveTitle(snapshot)).toBe('首页');
    snapshot.tabs = snapshot.tabs.map((tab) => ({ ...tab, title: '' }));
    expect(archiveTitle(snapshot)).toBe('example.com');
    snapshot.tabs = [];
    expect(archiveTitle(snapshot)).toBe('已归档窗口');
  });

  it('置顶优先，同状态按归档创建时间倒序且忽略置顶时间，不修改输入', () => {
    const make = (id: string, archivedAt: number, pinnedAt?: number): ArchivedWindow => ({
      id,
      archivedAt,
      pinned: pinnedAt !== undefined,
      ...(pinnedAt === undefined ? {} : { pinnedAt }),
      source: 'manual',
      snapshotHash: 'h',
      snapshot: { tabs: [], groups: [] },
    });
    const input = [
      make('old', 1),
      make('pin-old', 100, 10),
      make('new', 300),
      make('pin-new', 20, 50),
    ];
    expect(sortArchives(input).map((entry) => entry.id)).toEqual([
      'pin-old',
      'pin-new',
      'new',
      'old',
    ]);
    expect(input[0]?.id).toBe('old');
  });
});
