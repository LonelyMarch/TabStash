import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestoreJob, WindowSnapshot } from '../../src/domain/archive/models';

/** 浏览器薄适配器测试不启动真实 Edge，验证 API 参数与危险删除的边界。 */
const api = vi.hoisted(() => ({
  windows: { create: vi.fn(), update: vi.fn(), get: vi.fn() },
  tabs: {
    get: vi.fn(),
    remove: vi.fn(),
    create: vi.fn(),
    query: vi.fn(),
    group: vi.fn(),
    update: vi.fn(),
  },
  tabGroups: { query: vi.fn(), update: vi.fn() },
}));
vi.mock('wxt/browser', () => ({ browser: api }));

import { restoreBrowser } from '../../src/infrastructure/browser/restore-browser';

beforeEach(() => vi.resetAllMocks());

describe('恢复浏览器 API 边界', () => {
  it('窗口尺寸和最大化状态分开应用，避免传入冲突参数', async () => {
    await restoreBrowser.applyWindow(9, {
      tabs: [],
      groups: [],
      left: 5,
      top: 6,
      width: 900,
      height: 700,
      state: 'maximized',
    });
    expect(api.windows.update.mock.calls).toEqual([
      [9, { state: 'normal' }],
      [9, { left: 5, top: 6, width: 900, height: 700 }],
      [9, { state: 'maximized', focused: true }],
    ]);
  });

  it('用户已导航默认标签时拒绝删除，只删除仍为空白的原默认标签', async () => {
    api.tabs.get.mockResolvedValueOnce({ windowId: 9, url: 'https://example.com', pinned: false });
    await expect(restoreBrowser.removePlaceholder(9, 1)).rejects.toThrow('已被用户修改');
    expect(api.tabs.remove).not.toHaveBeenCalled();
    api.tabs.get.mockResolvedValueOnce({ windowId: 9, url: 'about:blank', pinned: false });
    await restoreBrowser.removePlaceholder(9, 1);
    expect(api.tabs.remove).toHaveBeenCalledWith(1);
  });

  it('标签顺序、置顶、组和活动状态错误都出现在核对结果中', async () => {
    const snapshot: WindowSnapshot = {
      tabs: [{ key: 't', url: 'https://example.com', title: '测试', pinned: true, index: 0 }],
      groups: [],
      activeTabKey: 't',
      state: 'maximized',
    };
    const job: RestoreJob = {
      requestId: 'r',
      archiveId: 'a',
      removeAfterRestore: true,
      sessionId: 's',
      startedAt: 1,
      state: 'running',
      windowId: 9,
      tabs: [{ key: 't', id: 2 }],
      groups: [],
      errors: [],
      totalTabs: 1,
      archiveRemoved: false,
    };
    api.windows.get.mockResolvedValue({
      state: 'normal',
      tabs: [{ id: 2, index: 0, pinned: false, active: false, groupId: 5 }],
    });
    api.tabGroups.query.mockResolvedValue([]);
    const errors = await restoreBrowser.verify(job, snapshot);
    expect(errors.map((error) => error.key)).toContain('diagnosticTabOrder');
    expect(errors.map((error) => error.key)).toContain('diagnosticTabGroup');
    expect(errors.map((error) => error.key)).toContain('diagnosticActiveTab');
    expect(errors.map((error) => error.key)).toContain('diagnosticWindowState');
  });
});
