import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoArchiveService } from '../../src/application/archive/auto-archive';
import type { ArchiveReceipt, LiveWindowShadow } from '../../src/domain/archive/models';
import { ClosedWindowRepository } from '../../src/infrastructure/db/closed-windows';
import { TabStashDatabase } from '../../src/infrastructure/db/database';
import { ArchiveRepository } from '../../src/infrastructure/db/repository';

let db: TabStashDatabase;
let archives: ArchiveRepository;
let closed: ClosedWindowRepository;
let service: AutoArchiveService;
let enabled: boolean;
let dependencies: ConstructorParameters<typeof AutoArchiveService>[0];

/** 同源窗口影子，测试使用固定 hash 以单独验证来源和时间范围的去重。 */
function shadow(windowId = 7, sessionId = 's'): LiveWindowShadow {
  return {
    sessionId,
    runtimeWindowId: windowId,
    updatedAt: Date.now(),
    snapshotHash: 'same-hash',
    snapshot: {
      groups: [],
      tabs: [{ key: 't', url: 'https://example.com', title: '测试', index: 0, pinned: false }],
    },
  };
}

/** 写入真实手动归档回执，避免仅模拟“有某条手动归档”的布尔结果。 */
async function manual(options: Partial<ArchiveReceipt> = {}): Promise<ArchiveReceipt> {
  const receipt: ArchiveReceipt = {
    requestId: crypto.randomUUID(),
    sessionId: 's',
    windowId: 7,
    closeAfterArchive: false,
    archiveId: crypto.randomUUID(),
    savedAt: Date.now(),
    outcome: 'saved',
    ...options,
  };
  await archives.commitManualArchive(
    {
      id: receipt.archiveId,
      archivedAt: receipt.savedAt,
      source: 'manual',
      pinned: false,
      snapshotHash: 'same-hash',
      snapshot: shadow().snapshot,
    },
    receipt,
    receipt.closeAfterArchive
      ? {
          id: receipt.requestId,
          sessionId: receipt.sessionId,
          windowId: receipt.windowId,
          type: 'archive-close',
          archiveId: receipt.archiveId,
          state: 'archive-written',
          startedAt: receipt.savedAt,
        }
      : undefined,
  );
  return receipt;
}

beforeEach(() => {
  db = new TabStashDatabase(`auto-test-${crypto.randomUUID()}`);
  archives = new ArchiveRepository(db);
  closed = new ClosedWindowRepository(db);
  enabled = true;
  dependencies = {
    repository: closed,
    settings: { get: async () => ({ autoArchiveClosedWindows: enabled }) },
    session: {
      getSessionId: async () => 's',
      getSuppression: vi.fn(async () => undefined),
      removeSuppression: vi.fn(async () => undefined),
    },
    settle: vi.fn(async () => undefined),
    changed: vi.fn(),
  };
  service = new AutoArchiveService(dependencies);
});
afterEach(async () => {
  await db.delete();
  vi.restoreAllMocks();
});

describe('自动归档关闭消费', () => {
  it('v2 升级到 v3 保留手动归档回执，并新增关闭事件表', async () => {
    const name = db.name;
    db.close();
    const old = new Dexie(name);
    old.version(2).stores({
      archives: '&id, archivedAt, pinnedAt, source',
      shadows: '[sessionId+runtimeWindowId], sessionId, updatedAt',
      operations: '&id, sessionId, type, state, startedAt',
      receipts: '&requestId, [sessionId+windowId], savedAt',
    });
    const receipt: ArchiveReceipt = {
      requestId: 'legacy-request',
      sessionId: 's',
      windowId: 7,
      closeAfterArchive: false,
      archiveId: 'legacy-archive',
      savedAt: 1,
      outcome: 'saved',
    };
    await old.table('receipts').add(receipt);
    old.close();
    await db.open();
    expect(await archives.getReceipt('legacy-request')).toEqual(receipt);
    await closed.record({
      sessionId: 's',
      windowId: 7,
      closedAt: 2,
      enabled: false,
      state: 'pending',
    });
    expect(await closed.pending()).toHaveLength(1);
  });
  it('ON 保存最近成功影子并消费它；重复关闭事件和 Worker 重启不增加归档', async () => {
    await archives.saveShadow(shadow());
    await Promise.all([service.onClosed(7), service.onClosed(7)]);
    await new AutoArchiveService(dependencies).reconcile();
    await service.onClosed(7);
    const list = await archives.getArchives();
    expect(list).toHaveLength(1);
    expect(list[0]?.source).toBe('auto-close');
    expect(list[0]?.snapshot).toEqual(shadow().snapshot);
    expect(await archives.getShadow('s', 7)).toBeUndefined();
  });

  it('窗口关闭后按影子中的标签映射合并最后检查点并清理临时数据', async () => {
    await archives.saveShadow({ ...shadow(), runtimeTabs: [{ key: 't', tabId: 81 }] });
    await db.pageProgress.put({
      sessionId: 's',
      tabId: 81,
      windowId: 7,
      updatedAt: Date.now(),
      progress: {
        url: 'https://example.com',
        scrolls: [{ path: 'document', top: 320, left: 0, maxTop: 900, maxLeft: 0 }],
        media: [],
      },
    });
    await service.onClosed(7);
    expect((await archives.getArchives())[0]?.snapshot.tabs[0]?.progress?.scrolls[0]?.top).toBe(
      320,
    );
    expect(await db.pageProgress.get(['s', 81])).toBeUndefined();
  });

  it('OFF 不归档，之后打开开关也不补归档该关闭事件', async () => {
    enabled = false;
    await archives.saveShadow(shadow());
    await service.onClosed(7);
    enabled = true;
    await service.onClosed(7);
    await service.reconcile();
    expect(await archives.getArchives()).toEqual([]);
    expect((await db.closedWindows.get(['s', 7]))?.outcome).toBe('disabled');
  });

  it('手动归档后立即关闭相同窗口，相同 hash 只保留一个归档', async () => {
    await archives.saveShadow(shadow());
    await manual();
    await service.onClosed(7);
    expect(await archives.getArchives()).toHaveLength(1);
    expect((await db.closedWindows.get(['s', 7]))?.outcome).toBe('duplicate');
  });

  it.each(['other-window', 'other-session', 'expired', 'changed'])(
    '%s 不会误用同 hash 的手动归档去重',
    async (kind) => {
      await archives.saveShadow({
        ...shadow(),
        snapshotHash: kind === 'changed' ? 'new-hash' : 'same-hash',
      });
      await manual({
        windowId: kind === 'other-window' ? 9 : 7,
        sessionId: kind === 'other-session' ? 'old' : 's',
        savedAt: Date.now() - (kind === 'expired' ? 60_000 : 0),
      });
      await service.onClosed(7);
      expect(await archives.getArchives()).toHaveLength(2);
    },
  );

  it('归档并关闭有持久关闭日志，即使影子较旧且 session 抑制已丢失也不重复', async () => {
    await archives.saveShadow({ ...shadow(), snapshotHash: 'older-shadow' });
    const receipt = await manual({ closeAfterArchive: true, savedAt: Date.now() - 60_000 });
    await archives.saveOperation({
      id: receipt.requestId,
      type: 'archive-close',
      sessionId: 's',
      windowId: 7,
      archiveId: receipt.archiveId,
      startedAt: receipt.savedAt,
      state: 'close-requested',
    });
    await service.onClosed(7);
    expect(await archives.getArchives()).toHaveLength(1);
    expect((await archives.getReceipt(receipt.requestId))?.outcome).toBe('closed');
    expect(await archives.getPendingOperations()).toEqual([]);
  });

  it('归档写入失败回滚消费，保留影子与待处理事件，重启后可重试', async () => {
    await archives.saveShadow(shadow());
    const fail = () => {
      throw new Error('配额不足');
    };
    db.archives.hook('creating', fail);
    await service.onClosed(7);
    expect((await service.status()).pendingCount).toBe(1);
    expect((await service.status()).error?.key).toBe('diagnosticAutoArchiveFailed');
    expect(await archives.getShadow('s', 7)).toBeDefined();
    db.archives.hook('creating').unsubscribe(fail);
    // 当前开关已经关闭，但明确记录过的 ON 关闭事件仍按原决策完成。
    enabled = false;
    await new AutoArchiveService(dependencies).reconcile();
    expect(await archives.getArchives()).toHaveLength(1);
    expect(await archives.getShadow('s', 7)).toBeUndefined();
  });

  it('关闭时设置读取失败保留快照，重试读到 ON 后完成归档', async () => {
    await archives.saveShadow(shadow());
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dependencies.settings.get = async () => {
      throw new Error('读取设置失败');
    };
    await service.onClosed(7);
    expect(await service.status()).toMatchObject({
      pendingCount: 1,
      error: { key: 'diagnosticAutoArchiveSettings' },
    });
    expect(await db.closedWindows.get(['s', 7])).toMatchObject({
      enabled: null,
      state: 'pending',
    });
    expect(await archives.getArchives()).toEqual([]);
    expect(await archives.getShadow('s', 7)).toBeDefined();
    expect(warning).toHaveBeenCalledOnce();
    dependencies.settings.get = async () => ({ autoArchiveClosedWindows: true });
    expect(await new AutoArchiveService(dependencies).reconcile()).toMatchObject({
      pendingCount: 0,
      reviewCount: 0,
      error: null,
    });
    expect((await db.closedWindows.get(['s', 7]))?.outcome).toBe('archived');
    expect(await archives.getArchives()).toHaveLength(1);
    expect(await archives.getShadow('s', 7)).toBeUndefined();
  });

  it('启动核对旧版未知设置时，重读到 OFF 后才清理快照', async () => {
    await archives.saveShadow({
      ...shadow(7, 'old'),
      runtimeTabs: [{ key: 't', tabId: 81 }],
    });
    await closed.record({
      sessionId: 'old',
      windowId: 7,
      closedAt: Date.now(),
      enabled: null,
      state: 'needs-review',
    });
    await db.pageProgress.put({
      sessionId: 'old',
      tabId: 81,
      windowId: 7,
      updatedAt: Date.now(),
      progress: { url: 'https://example.com', scrolls: [], media: [] },
    });
    enabled = false;
    const result = await new AutoArchiveService(dependencies).reconcile();

    expect(result).toMatchObject({ pendingCount: 0, reviewCount: 0, error: null });
    expect(await db.closedWindows.get(['old', 7])).toMatchObject({
      enabled: false,
      state: 'done',
      outcome: 'disabled',
    });
    expect(await archives.getShadow('old', 7)).toBeUndefined();
    expect(await db.pageProgress.get(['old', 81])).toBeUndefined();
    expect(await archives.getArchives()).toEqual([]);
  });

  it('旧版尚未消费的未知设置记录在读取失败时继续保留', async () => {
    await archives.saveShadow(shadow(7, 'old'));
    await closed.record({
      sessionId: 'old',
      windowId: 7,
      closedAt: Date.now(),
      enabled: null,
      state: 'pending',
    });

    dependencies.settings.get = async () => {
      throw new Error('仍无法读取设置');
    };
    const result = await service.reconcile();

    expect(await db.closedWindows.get(['old', 7])).toMatchObject({
      enabled: null,
      state: 'pending',
    });
    expect(result).toMatchObject({
      pendingCount: 1,
      error: { key: 'diagnosticAutoArchiveSettings' },
    });
    expect(await archives.getShadow('old', 7)).toBeDefined();
  });

  it('缺少影子时标记待核对；只有旧会话影子不能冒充当前窗口', async () => {
    await archives.saveShadow(shadow(7, 'old'));
    await service.onClosed(7);
    expect((await service.status()).reviewCount).toBe(1);
    expect(await archives.getArchives()).toEqual([]);
    expect(await archives.getShadow('old', 7)).toBeDefined();
  });

  it('等待正在完成的写入之后才消费，使用最终落盘影子', async () => {
    dependencies.settle = async () => {
      await archives.saveShadow(shadow());
    };
    await service.onClosed(7);
    expect(await archives.getArchives()).toHaveLength(1);
  });

  it('旧会话明确记录的关闭事件可重试，但不操作同 ID 的新会话影子', async () => {
    await archives.saveShadow(shadow(7, 'old'));
    await archives.saveShadow(shadow());
    await closed.record({
      sessionId: 'old',
      windowId: 7,
      closedAt: Date.now(),
      enabled: true,
      state: 'pending',
    });
    await service.reconcile();
    expect(await archives.getArchives()).toHaveLength(1);
    expect(await archives.getShadow('s', 7)).toBeDefined();
    expect(dependencies.settle).not.toHaveBeenCalled();
  });
});
