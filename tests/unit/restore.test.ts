import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RestoreBrowser, RestoreService } from '../../src/application/archive/restore';
import type { RestoreCommand, WindowSnapshot } from '../../src/domain/archive/models';
import { TabStashDatabase } from '../../src/infrastructure/db/database';
import { RestoreRepository } from '../../src/infrastructure/db/restore-repository';

let db: TabStashDatabase;
let repository: RestoreRepository;
let browser: RestoreBrowser;
let service: RestoreService;
const snapshot: WindowSnapshot = {
  state: 'maximized',
  left: 10,
  top: 20,
  width: 900,
  height: 700,
  activeTabKey: 'b',
  groups: [{ key: 'g', title: '资料', color: 'blue', collapsed: false }],
  tabs: [
    { key: 'a', url: 'https://example.com', title: '固定', pinned: true, index: 0 },
    { key: 'b', url: 'https://example.org', title: '分组', pinned: false, index: 1, groupKey: 'g' },
    {
      key: 'c',
      url: 'https://example.net',
      title: '分组二',
      pinned: false,
      index: 2,
      groupKey: 'g',
    },
  ],
};

/** 创建一个新的用户恢复操作；消息重试应复用返回对象。 */
function command(removeAfterRestore = false): RestoreCommand {
  return { requestId: crypto.randomUUID(), archiveId: 'a1', removeAfterRestore };
}

/** 模拟 Worker 重建，仅更换用例实例，持久数据库保持不变。 */
function newService(): RestoreService {
  return new RestoreService({ repository, browser, sessionId: async () => 's', changed: vi.fn() });
}

beforeEach(async () => {
  db = new TabStashDatabase(`restore-test-${crypto.randomUUID()}`);
  repository = new RestoreRepository(db);
  await db.archives.add({
    id: 'a1',
    archivedAt: 1,
    pinned: false,
    source: 'manual',
    snapshotHash: 'h',
    snapshot,
  });
  let nextId = 10;
  browser = {
    createWindow: vi.fn(async () => ({ windowId: 9, placeholderTabId: 1 })),
    createTab: vi.fn(async () => nextId++),
    removePlaceholder: vi.fn(async () => undefined),
    createGroup: vi.fn(async () => 20),
    collapseGroup: vi.fn(async () => undefined),
    activateTab: vi.fn(async () => undefined),
    applyWindow: vi.fn(async () => undefined),
    verify: vi.fn(async () => []),
    restoreProgress: vi.fn(async () => []),
  };
  service = newService();
});
afterEach(async () => {
  await db.delete();
});

describe('恢复与恢复并移除', () => {
  it('v3 升级保留关闭记录，v4 可保存恢复进度', async () => {
    const name = `upgrade-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(3).stores({
      archives: '&id, archivedAt, pinnedAt, source',
      shadows: '[sessionId+runtimeWindowId], sessionId, updatedAt',
      operations: '&id, sessionId, type, state, startedAt',
      receipts: '&requestId, [sessionId+windowId], savedAt',
      closedWindows: '[sessionId+windowId], state, closedAt',
    });
    const record = { sessionId: 'old', windowId: 7, closedAt: 1, enabled: true, state: 'pending' };
    await old.table('closedWindows').add(record);
    old.close();
    const upgraded = new TabStashDatabase(name);
    try {
      expect(await upgraded.closedWindows.get(['old', 7])).toEqual(record);
      expect(await upgraded.restoreJobs.count()).toBe(0);
    } finally {
      await upgraded.delete();
    }
  });

  it('创建窗口失败返回明确部分失败并保留归档', async () => {
    browser.createWindow = vi.fn(async () => {
      throw new Error('窗口创建被拒绝');
    });
    const result = await service.execute(command(true));
    expect(result.errors.join('；')).toContain('窗口创建被拒绝');
    expect(result.state).toBe('partial');
    expect(browser.createTab).not.toHaveBeenCalled();
    expect(await db.archives.get('a1')).toBeDefined();
  });

  it('不支持的 URL 类型不会交给浏览器执行，其余标签继续恢复', async () => {
    const changed = structuredClone(snapshot);
    const first = changed.tabs[0];
    if (!first) throw new Error('测试数据缺少标签');
    first.url = 'javascript:alert(1)';
    await db.archives.update('a1', { snapshot: changed });
    const result = await service.execute(command(true));
    expect(result.state).toBe('partial');
    expect(result.tabs).toHaveLength(2);
    expect(browser.createTab).toHaveBeenCalledTimes(2);
    expect(result.errors.join('；')).toContain('不支持');
    expect(await db.archives.get('a1')).toBeDefined();
  });
  it('普通恢复保留归档，按顺序创建标签、恢复组、活动标签和窗口状态', async () => {
    const result = await service.execute(command());
    expect(result.state).toBe('complete');
    expect(result.tabs).toHaveLength(3);
    expect(result.archiveRemoved).toBe(false);
    expect(await db.archives.get('a1')).toBeDefined();
    expect(browser.createTab).toHaveBeenNthCalledWith(1, 9, snapshot.tabs[0], 0);
    expect(browser.createTab).toHaveBeenNthCalledWith(3, 9, snapshot.tabs[2], 2);
    expect(browser.createGroup).toHaveBeenCalledWith(9, [11, 12], snapshot.groups[0]);
    expect(browser.activateTab).toHaveBeenCalledWith(11);
    expect(browser.applyWindow).toHaveBeenCalledWith(9, snapshot);
    expect(await db.operations.count()).toBe(0);
  });

  it('完整核对成功后才删除归档；消息重试甚至归档已移除也不重复创建窗口', async () => {
    browser.verify = vi.fn(async () => {
      expect(await db.archives.get('a1')).toBeDefined();
      return [];
    });
    const input = command(true);
    const result = await service.execute(input);
    expect(result.archiveRemoved).toBe(true);
    expect(await db.archives.get('a1')).toBeUndefined();
    expect((await newService().execute(input)).archiveRemoved).toBe(true);
    expect(browser.createWindow).toHaveBeenCalledTimes(1);
  });

  it('网页进度失败只形成警告，结构完整时恢复并移除仍删除原归档', async () => {
    const changed = structuredClone(snapshot);
    const first = changed.tabs[0];
    if (!first) throw new Error('测试归档缺少标签');
    first.progress = {
      url: first.url as string,
      scrolls: [{ path: 'document', top: 200, left: 0, maxTop: 500, maxLeft: 0 }],
      media: [],
    };
    await db.archives.update('a1', { snapshot: changed });
    browser.restoreProgress = vi.fn(async () => ['页面滚动位置未完整还原']);
    const result = await service.execute(command(true));
    expect(browser.restoreProgress).toHaveBeenCalledWith(10, first.progress);
    expect(result.state).toBe('complete');
    expect(result.progressWarnings?.join('；')).toContain('页面滚动位置未完整还原');
    expect(result.archiveRemoved).toBe(true);
    expect(await db.archives.get('a1')).toBeUndefined();
  });

  it('受限标签失败仍继续其他标签，剩余组成员尽力分组，原归档保留', async () => {
    browser.createTab = vi.fn(async (_windowId, tab) => {
      if (tab.key === 'b') throw new Error('受限 URL');
      return tab.key === 'a' ? 10 : 12;
    });
    const result = await service.execute(command(true));
    expect(result.state).toBe('partial');
    expect(result.tabs).toHaveLength(2);
    expect(result.errors.join('；')).toContain('受限 URL');
    expect(browser.createGroup).toHaveBeenCalledWith(9, [12], snapshot.groups[0]);
    expect(await db.archives.get('a1')).toBeDefined();
  });

  it.each([
    'createGroup',
    'activateTab',
    'collapseGroup',
    'applyWindow',
    'removePlaceholder',
  ] as const)('%s 失败时保留归档并返回部分恢复', async (step) => {
    vi.mocked(browser[step]).mockRejectedValueOnce(new Error('模拟步骤失败'));
    const result = await service.execute(command(true));
    expect(result.state).toBe('partial');
    expect(result.archiveRemoved).toBe(false);
    expect(await db.archives.get('a1')).toBeDefined();
  });

  it('浏览器最终核对不一致时即使全部标签创建成功也不删除归档', async () => {
    browser.verify = vi.fn(async () => ['实际分组不一致']);
    const result = await service.execute(command(true));
    expect(result.tabs).toHaveLength(3);
    expect(result.state).toBe('partial');
    expect(await db.archives.get('a1')).toBeDefined();
  });

  it('全标签失败时不删除默认空白标签，不关闭新窗口', async () => {
    browser.createTab = vi.fn(async () => {
      throw new Error('拒绝');
    });
    const result = await service.execute(command(true));
    expect(result.tabs).toHaveLength(0);
    expect(browser.removePlaceholder).not.toHaveBeenCalled();
    expect(await db.archives.get('a1')).toBeDefined();
  });

  it('持久操作意图写入失败时不创建浏览器窗口', async () => {
    db.restoreJobs.hook('creating', () => {
      throw new Error('存储失败');
    });
    await expect(service.execute(command(true))).rejects.toThrow('存储失败');
    expect(browser.createWindow).not.toHaveBeenCalled();
    expect(await db.archives.get('a1')).toBeDefined();
  });

  it('创建窗口后记录进度失败停止后续操作，保留归档和已经创建的窗口', async () => {
    vi.spyOn(repository, 'save').mockRejectedValueOnce(new Error('进度写入失败'));
    const result = await service.execute(command(true));
    expect(result.windowId).toBe(9);
    expect(result.state).toBe('partial');
    expect(browser.createTab).not.toHaveBeenCalled();
    expect(await db.archives.get('a1')).toBeDefined();
  });

  it('最终事务写入回执失败时，删除归档也必须回滚', async () => {
    db.restoreJobs.hook('updating', (changes) => {
      if ('archiveRemoved' in changes && changes.archiveRemoved === true)
        throw new Error('最终回执失败');
    });
    const result = await service.execute(command(true));
    expect(result.state).toBe('partial');
    expect(await db.archives.get('a1')).toBeDefined();
  });

  it('Worker 启动核对中断任务，只保留进度和归档，不自动创建窗口', async () => {
    const input = command(true);
    const { job } = await repository.begin(input, 'old-session');
    await repository.save({ ...job, windowId: 900, tabs: [{ key: 'a', id: 901 }] });
    const result = await newService().execute(input);
    expect(result.state).toBe('interrupted');
    expect(result.windowId).toBe(900);
    expect(browser.createWindow).not.toHaveBeenCalled();
    expect(await db.archives.get('a1')).toBeDefined();
    expect(await repository.issues()).toHaveLength(1);
  });

  it('同一归档并发请求互斥，同一请求共享结果', async () => {
    let release!: () => void;
    browser.createWindow = vi.fn(
      () =>
        new Promise<{ windowId: number; placeholderTabId: number }>((resolve) => {
          release = () => resolve({ windowId: 9, placeholderTabId: 1 });
        }),
    );
    const input = command();
    const first = service.execute(input);
    const second = service.execute(input);
    await expect(service.execute(command())).rejects.toThrow('正在恢复');
    await vi.waitFor(() => expect(browser.createWindow).toHaveBeenCalled());
    release();
    expect((await Promise.all([first, second]))[0]?.state).toBe('complete');
    expect(browser.createWindow).toHaveBeenCalledTimes(1);
  });
});
