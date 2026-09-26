import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualArchiveService } from '../../src/application/archive/manual-archive';
import type { ArchiveCommand, WindowSnapshot } from '../../src/domain/archive/models';
import { TabStashDatabase } from '../../src/infrastructure/db/database';
import { ArchiveRepository } from '../../src/infrastructure/db/repository';

const snapshot: WindowSnapshot = {
  groups: [],
  tabs: [{ key: 't1', title: '测试', url: 'https://example.com', index: 0, pinned: false }],
  activeTabKey: 't1',
};
let db: TabStashDatabase;
let repository: ArchiveRepository;
let service: ManualArchiveService;
let dependencies: ConstructorParameters<typeof ManualArchiveService>[0];

/** 生成与面板完全一致的稳定请求 ID。 */
function command(closeAfterArchive = false): ArchiveCommand {
  return { requestId: crypto.randomUUID(), windowId: 7, closeAfterArchive };
}

beforeEach(() => {
  db = new TabStashDatabase(`archive-test-${crypto.randomUUID()}`);
  repository = new ArchiveRepository(db);
  dependencies = {
    repository,
    capture: vi.fn(async () => structuredClone(snapshot)),
    close: vi.fn(async () => undefined),
    changed: vi.fn(),
    session: {
      getSessionId: async () => 'session-1',
      saveSuppression: vi.fn(async () => undefined),
      removeSuppression: vi.fn(async () => undefined),
    },
  };
  service = new ManualArchiveService(dependencies);
});

afterEach(async () => {
  await db.delete();
});

describe('手动归档安全性', () => {
  it('普通归档保存完整快照并保留窗口，相同请求重试只返回原归档', async () => {
    const input = command();
    const first = await service.execute(input);
    const restarted = new ManualArchiveService(dependencies);
    const again = await restarted.execute(input);
    expect(again.archiveId).toBe(first.archiveId);
    expect(await repository.getArchives()).toHaveLength(1);
    expect((await repository.getArchives())[0]?.snapshot).toEqual(snapshot);
    expect(dependencies.close).not.toHaveBeenCalled();
    expect(dependencies.capture).toHaveBeenCalledTimes(1);
  });

  it('归档、回执、关闭日志持久化并写入抑制后才调用关闭', async () => {
    const input = command(true);
    dependencies.close = vi.fn(async () => {
      expect(await repository.getArchives()).toHaveLength(1);
      expect(await repository.getReceipt(input.requestId)).toBeDefined();
      expect((await repository.getPendingOperations())[0]?.state).toBe('close-requested');
      expect(dependencies.session.saveSuppression).toHaveBeenCalledTimes(1);
    });
    const result = await service.execute(input);
    expect(result.outcome).toBe('closed');
    expect(await repository.getPendingOperations()).toEqual([]);
    expect((await repository.getReceipt(input.requestId))?.outcome).toBe('closed');
  });

  it('回执写入失败会回滚归档，且绝不关闭窗口', async () => {
    db.receipts.hook('creating', () => {
      throw new Error('写入失败');
    });
    await expect(service.execute(command(true))).rejects.toThrow('写入失败');
    expect(await repository.getArchives()).toEqual([]);
    expect(await repository.getPendingOperations()).toEqual([]);
    expect(dependencies.close).not.toHaveBeenCalled();
  });

  it('关闭 API 失败保留归档，重试同一请求不新增归档或再次关闭', async () => {
    dependencies.close = vi.fn(async () => {
      throw new Error('关闭被拒绝');
    });
    const input = command(true);
    const result = await service.execute(input);
    expect(result.outcome).toBe('close-failed');
    expect(result.warning).toContain('关闭被拒绝');
    expect(await repository.getArchives()).toHaveLength(1);
    await new ManualArchiveService(dependencies).execute(input);
    expect(dependencies.close).toHaveBeenCalledTimes(1);
  });

  it('session 抑制写入失败时保留归档与窗口', async () => {
    dependencies.session.saveSuppression = vi.fn(async () => {
      throw new Error('会话写入失败');
    });
    const result = await service.execute(command(true));
    expect(result.outcome).toBe('close-failed');
    expect(result.warning).toContain('会话写入失败');
    expect(await repository.getArchives()).toHaveLength(1);
    expect(dependencies.close).not.toHaveBeenCalled();
  });

  it('保存期间标签内容变化时不关闭窗口', async () => {
    dependencies.capture = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue({
        ...snapshot,
        tabs: [
          ...snapshot.tabs,
          { key: 't2', url: 'https://example.net', title: '新标签', index: 1, pinned: false },
        ],
      });
    const result = await service.execute(command(true));
    expect(result.warning).toContain('内容在保存期间变化');
    expect(dependencies.close).not.toHaveBeenCalled();
    expect((await repository.getArchives())[0]?.snapshot.tabs).toHaveLength(1);
  });

  it('同一窗口并发请求互斥，相同请求共享一次执行', async () => {
    let release!: (value: WindowSnapshot) => void;
    dependencies.capture = vi.fn(
      () =>
        new Promise<WindowSnapshot>((resolve) => {
          release = resolve;
        }),
    );
    const input = command();
    const first = service.execute(input);
    const second = service.execute(input);
    await expect(service.execute(command())).rejects.toThrow('正在归档');
    await vi.waitFor(() => expect(dependencies.capture).toHaveBeenCalled());
    release(snapshot);
    const results = await Promise.all([first, second]);
    expect(results[0]?.archiveId).toBe(results[1]?.archiveId);
    expect(await repository.getArchives()).toHaveLength(1);
  });

  it('关闭后写回执失败保留待核对日志，Worker 重建不会重放关闭', async () => {
    vi.spyOn(repository, 'finishManualArchive').mockRejectedValueOnce(new Error('落盘失败'));
    const input = command(true);
    expect((await service.execute(input)).warning).toContain('窗口已关闭');
    expect(await repository.getPendingOperations()).toHaveLength(1);
    const retry = await new ManualArchiveService(dependencies).execute(input);
    expect(retry.warning).toContain('待核对');
    expect(dependencies.close).toHaveBeenCalledTimes(1);
    expect(await repository.getArchives()).toHaveLength(1);
  });

  it('v1 数据库升级到 v2 后保留旧归档并可写入回执', async () => {
    const name = db.name;
    db.close();
    const old = new Dexie(name);
    old.version(1).stores({
      archives: '&id, archivedAt, pinnedAt, source',
      shadows: '[sessionId+runtimeWindowId], sessionId, updatedAt',
      operations: '&id, sessionId, type, state, startedAt',
    });
    await old.table('archives').add({
      id: 'legacy',
      archivedAt: 1,
      pinned: false,
      source: 'manual',
      snapshotHash: 'h',
      snapshot,
    });
    old.close();
    await db.open();
    await service.execute(command());
    expect(await repository.getArchives()).toHaveLength(2);
    expect(await db.receipts.count()).toBe(1);
  });
});
