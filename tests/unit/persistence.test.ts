import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ArchivedWindow,
  LiveWindowShadow,
  PendingOperation,
} from '../../src/domain/archive/models';
import { TabStashDatabase } from '../../src/infrastructure/db/database';
import { ArchiveRepository } from '../../src/infrastructure/db/repository';

let db: TabStashDatabase;
let repository: ArchiveRepository;

/** 创建包含组、活动标签和窗口位置的归档，避免只验证空对象往返。 */
function archive(): ArchivedWindow {
  return {
    id: 'archive-1',
    archivedAt: 100,
    pinned: false,
    source: 'manual-close',
    snapshotHash: 'hash-1',
    snapshot: {
      state: 'normal',
      left: 10,
      top: 20,
      width: 1000,
      height: 800,
      activeTabKey: 'tab-1',
      tabs: [
        {
          key: 'tab-1',
          url: 'https://example.com',
          title: '示例',
          index: 0,
          pinned: false,
          groupKey: 'group-1',
        },
      ],
      groups: [{ key: 'group-1', title: '资料', color: 'blue', collapsed: false }],
    },
  };
}

/** 构造已归档但尚未请求关闭的操作，测试重启后可核对的状态。 */
function operation(): PendingOperation {
  return {
    id: 'operation-1',
    type: 'archive-close',
    sessionId: 'session-1',
    windowId: 1,
    archiveId: 'archive-1',
    state: 'archive-written',
    startedAt: 100,
  };
}

beforeEach(() => {
  db = new TabStashDatabase(`test-${crypto.randomUUID()}`);
  repository = new ArchiveRepository(db);
});

afterEach(async () => {
  await db.delete();
});

describe('IndexedDB 持久化与事务', () => {
  it('关闭连接并创建新数据库实例后，完整归档和操作日志仍可读取', async () => {
    await repository.commitArchiveAndOperation(archive(), operation());
    const name = db.name;
    db.close();
    db = new TabStashDatabase(name);
    repository = new ArchiveRepository(db);
    expect(await repository.getArchives()).toEqual([archive()]);
    expect(await repository.getPendingOperations()).toEqual([operation()]);
    expect(await repository.getStatus()).toEqual({ archiveCount: 1, pendingOperationCount: 1 });
  });

  it('操作日志写入失败时，事务回滚已执行的归档写入并返回失败', async () => {
    // 模拟第二张表写入时存储不可用，确保不是仅验证第一步就失败的简单场景。
    db.operations.hook('creating', () => {
      throw new Error('模拟磁盘写入失败');
    });
    await expect(repository.commitArchiveAndOperation(archive(), operation())).rejects.toThrow(
      '模拟磁盘写入失败',
    );
    expect(await repository.getStatus()).toEqual({ archiveCount: 0, pendingOperationCount: 0 });
  });

  it('重复归档 ID 不覆盖快照，调用方对象变化也不改变已存数据', async () => {
    const value = archive();
    await repository.addArchive(value);
    const firstTab = value.snapshot.tabs[0];
    if (!firstTab) throw new Error('测试归档缺少标签');
    firstTab.title = '后来改变';
    await expect(repository.addArchive(value)).rejects.toThrow();
    expect(await repository.getArchives()).toEqual([archive()]);
  });

  it('不接受与操作日志关联不一致的归档', async () => {
    await expect(
      repository.commitArchiveAndOperation({ ...archive(), id: 'other' }, operation()),
    ).rejects.toThrow('不匹配');
    expect(await repository.getStatus()).toEqual({ archiveCount: 0, pendingOperationCount: 0 });
  });

  it('窗口影子跨连接持久化，拒绝旧状态或空窗口覆盖，且按会话隔离', async () => {
    const shadow: LiveWindowShadow = {
      sessionId: 'session-1',
      runtimeWindowId: 1,
      updatedAt: 200,
      snapshotHash: 'hash-1',
      snapshot: archive().snapshot,
    };
    await repository.saveShadow(shadow);
    await repository.saveShadow({ ...shadow, updatedAt: 100, snapshotHash: 'old' });
    await expect(
      repository.saveShadow({ ...shadow, snapshot: { tabs: [], groups: [] } }),
    ).rejects.toThrow('空窗口');
    db.close();
    await db.open();
    expect(await repository.getShadow('session-1', 1)).toEqual(shadow);
    expect(await repository.getShadow('another-session', 1)).toBeUndefined();
  });

  it('恢复操作的中间进度跨数据库连接保留，不自动删除原归档', async () => {
    await repository.addArchive(archive());
    const restore: PendingOperation = {
      id: 'restore-1',
      sessionId: 'session-1',
      type: 'restore-remove',
      archiveId: 'archive-1',
      restoredWindowId: 8,
      state: 'window-created',
      startedAt: 300,
    };
    await repository.saveOperation(restore);
    db.close();
    await db.open();
    expect(await repository.getPendingOperations()).toEqual([restore]);
    expect(await repository.getArchives()).toHaveLength(1);
  });
});
