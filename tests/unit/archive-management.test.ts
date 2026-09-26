import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchivedWindow } from '../../src/domain/archive/models';
import { sortArchives } from '../../src/domain/archive/presentation';
import { ArchiveManagementRepository } from '../../src/infrastructure/db/archive-management';
import { TabStashDatabase } from '../../src/infrastructure/db/database';
import { RestoreRepository } from '../../src/infrastructure/db/restore-repository';

let db: TabStashDatabase;
let repository: ArchiveManagementRepository;
const archive: ArchivedWindow = {
  id: 'a',
  archivedAt: 1,
  pinned: false,
  source: 'manual',
  snapshotHash: 'h',
  snapshot: {
    groups: [],
    tabs: [{ key: 't', title: '测试', url: 'https://example.com', pinned: false, index: 0 }],
  },
};

beforeEach(async () => {
  db = new TabStashDatabase(`management-${crypto.randomUUID()}`);
  repository = new ArchiveManagementRepository(db);
  await db.archives.bulkAdd([archive, { ...archive, id: 'b', archivedAt: 2 }]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

describe('归档管理', () => {
  it('先后置顶仍按归档创建时间排序，重复请求不修改时间，取消置顶恢复时间排序', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    await repository.setPinned('b', true);
    now.mockReturnValue(200);
    await repository.setPinned('a', true);
    now.mockReturnValue(300);
    await repository.setPinned('b', true);
    expect(sortArchives(await db.archives.toArray()).map((entry) => entry.id)).toEqual(['b', 'a']);
    expect((await db.archives.get('b'))?.pinnedAt).toBe(100);
    await repository.setPinned('a', false);
    expect((await db.archives.get('a'))?.pinnedAt).toBeUndefined();
    expect(sortArchives(await db.archives.toArray()).map((entry) => entry.id)).toEqual(['b', 'a']);
    expect((await db.archives.get('a'))?.snapshot).toEqual(archive.snapshot);
  });

  it('置顶状态跨数据库重开保留', async () => {
    await repository.setPinned('a', true);
    db.close();
    await db.open();
    expect((await db.archives.get('a'))?.pinned).toBe(true);
  });

  it('删除只影响指定归档，重复删除幂等', async () => {
    expect(await repository.delete('a')).toBe(true);
    expect(await repository.delete('a')).toBe(false);
    expect((await db.archives.toArray()).map((entry) => entry.id)).toEqual(['b']);
  });

  it('正在恢复的归档不能被另一侧栏删除', async () => {
    await new RestoreRepository(db).begin(
      { requestId: 'r', archiveId: 'a', removeAfterRestore: false },
      's',
    );
    await expect(repository.delete('a')).rejects.toThrow('进行中或待核对');
    expect(await db.archives.get('a')).toBeDefined();
  });

  it('存在未核对关闭日志时拒绝删除，避免提前破坏保存保障', async () => {
    await db.operations.add({
      id: 'o',
      sessionId: 's',
      startedAt: 1,
      type: 'archive-close',
      windowId: 1,
      archiveId: 'a',
      state: 'close-requested',
    });
    await expect(repository.delete('a')).rejects.toThrow('待核对');
    expect(await db.archives.get('a')).toBeDefined();
  });

  it('删除写入失败回滚，不报告删除成功', async () => {
    db.archives.hook('deleting', () => {
      throw new Error('数据库写入失败');
    });
    await expect(repository.delete('a')).rejects.toThrow('数据库写入失败');
    expect(await db.archives.get('a')).toEqual(archive);
  });

  it('并发开始恢复与删除只能有一项成功，不能绕过事务检查', async () => {
    const results = await Promise.allSettled([
      new RestoreRepository(db).begin(
        { requestId: 'r', archiveId: 'a', removeAfterRestore: false },
        's',
      ),
      repository.delete('a'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('缺失归档不能被置顶创建成不完整记录', async () => {
    await expect(repository.setPinned('missing', true)).rejects.toThrow('不存在');
    expect(await db.archives.count()).toBe(2);
  });
});
