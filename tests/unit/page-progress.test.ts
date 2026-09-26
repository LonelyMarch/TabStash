import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageProgress, WindowSnapshot } from '../../src/domain/archive/models';
import { attachPageProgress, parsePageProgress } from '../../src/domain/archive/page-progress';
import { TabStashDatabase } from '../../src/infrastructure/db/database';
import { PageProgressRepository } from '../../src/infrastructure/db/page-progress-repository';

const progress: PageProgress = {
  url: 'https://example.com/article',
  scrolls: [{ path: 'document', top: 400, left: 0, maxTop: 1000, maxLeft: 0 }],
  media: [
    {
      path: 'html > body:nth-of-type(1) > video:nth-of-type(1)',
      kind: 'video',
      time: 12,
      duration: 60,
    },
  ],
};
const snapshot: WindowSnapshot = {
  tabs: [{ key: 't', url: progress.url, title: '文章', index: 0, pinned: false }],
  groups: [],
};
const databases: TabStashDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});

describe('网页进度检查点', () => {
  it('限制字段数量、大小及非有限时间，拒绝异常网页消息', () => {
    expect(parsePageProgress(progress)).toEqual(progress);
    expect(
      parsePageProgress({ ...progress, scrolls: Array(22).fill(progress.scrolls[0]) }),
    ).toBeNull();
    expect(
      parsePageProgress({ ...progress, media: [{ ...progress.media[0], time: Infinity }] }),
    ).toBeNull();
    expect(parsePageProgress({ ...progress, url: 'edge://settings' })).toBeNull();
  });

  it('按快照键与标签 ID 合并，仅相同网址和有效期内的记录可用', () => {
    const checkpoint = { sessionId: 's', tabId: 7, windowId: 1, updatedAt: 1000, progress };
    const mapping = [{ key: 't', tabId: 7 }];
    expect(attachPageProgress(snapshot, mapping, [checkpoint], 2000).tabs[0]?.progress).toEqual(
      progress,
    );
    expect(attachPageProgress(snapshot, [{ key: 't', tabId: 8 }], [checkpoint], 2000)).toEqual(
      snapshot,
    );
    expect(
      attachPageProgress(
        snapshot,
        mapping,
        [{ ...checkpoint, progress: { ...progress, url: 'https://example.com/other' } }],
        2000,
      ),
    ).toEqual(snapshot);
    expect(attachPageProgress(snapshot, mapping, [checkpoint], 9 * 24 * 60 * 60 * 1000)).toEqual(
      snapshot,
    );
  });

  it('v4 数据升级到 v5 后保留原归档，并使较旧检查点无法覆盖新进度', async () => {
    const name = `progress-upgrade-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(4).stores({
      archives: '&id, archivedAt, pinnedAt, source',
      shadows: '[sessionId+runtimeWindowId], sessionId, updatedAt',
      operations: '&id, sessionId, type, state, startedAt',
      receipts: '&requestId, [sessionId+windowId], savedAt',
      closedWindows: '[sessionId+windowId], state, closedAt',
      restoreJobs: '&requestId, archiveId, state, startedAt',
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
    const db = new TabStashDatabase(name);
    databases.push(db);
    const repository = new PageProgressRepository(db);
    await repository.save({ sessionId: 's', tabId: 7, windowId: 1, updatedAt: 2000, progress });
    await repository.save({
      sessionId: 's',
      tabId: 7,
      windowId: 1,
      updatedAt: 1000,
      progress: { ...progress, scrolls: [] },
    });
    expect((await db.archives.get('legacy'))?.snapshot).toEqual(snapshot);
    expect((await db.pageProgress.get(['s', 7]))?.progress).toEqual(progress);
  });
});
