import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { translateDiagnostic } from '../../src/i18n/core';
import { TabStashDatabase } from '../../src/infrastructure/db/database';
import { ArchiveRepository } from '../../src/infrastructure/db/repository';
import { RestoreRepository } from '../../src/infrastructure/db/restore-repository';

describe('v0.1.0 持久诊断升级', () => {
  it('在数据库事务中保留旧回执和恢复记录，并将字符串规范化为可显示诊断', async () => {
    const name = `legacy-diagnostics-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    // 使用 v0.1.0 的 v5 索引定义和原始字符串，模拟用户升级前已经落盘的数据。
    old.version(5).stores({
      archives: '&id, archivedAt, pinnedAt, source',
      shadows: '[sessionId+runtimeWindowId], sessionId, updatedAt',
      operations: '&id, sessionId, type, state, startedAt',
      receipts: '&requestId, [sessionId+windowId], savedAt',
      closedWindows: '[sessionId+windowId], state, closedAt',
      restoreJobs: '&requestId, archiveId, state, startedAt',
      pageProgress: '[sessionId+tabId], updatedAt, windowId',
    });
    await old.table('receipts').add({
      requestId: 'old-archive',
      windowId: 7,
      closeAfterArchive: true,
      sessionId: 'old-session',
      archiveId: 'a1',
      savedAt: 1,
      outcome: 'close-failed',
      warning: '旧版关闭警告',
    });
    await old.table('restoreJobs').add({
      requestId: 'old-restore',
      archiveId: 'a1',
      removeAfterRestore: false,
      sessionId: 'old-session',
      startedAt: 2,
      state: 'partial',
      tabs: [],
      groups: [],
      totalTabs: 1,
      errors: ['旧版恢复错误'],
      progressWarnings: ['旧版进度警告'],
      archiveRemoved: false,
    });
    old.close();

    const upgraded = new TabStashDatabase(name);
    try {
      const receipt = await new ArchiveRepository(upgraded).getReceipt('old-archive');
      const job = (await new RestoreRepository(upgraded).issues())[0];
      expect(receipt?.warning).toEqual({
        key: 'diagnosticLegacy',
        params: { detail: '旧版关闭警告' },
      });
      expect(job?.errors).toEqual([
        { key: 'diagnosticLegacy', params: { detail: '旧版恢复错误' } },
      ]);
      expect(job?.progressWarnings).toEqual([
        { key: 'diagnosticLegacy', params: { detail: '旧版进度警告' } },
      ]);
      const restoredWarning = job?.errors[0];
      if (!restoredWarning) throw new Error('旧版恢复错误未迁移');
      expect(translateDiagnostic('fr', restoredWarning)).toBe('旧版恢复错误');
      expect(await upgraded.receipts.count()).toBe(1);
      expect(await upgraded.restoreJobs.count()).toBe(1);
    } finally {
      await upgraded.delete();
    }
  });
});
