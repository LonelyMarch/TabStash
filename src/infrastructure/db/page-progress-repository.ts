import type {
  PageProgressCheckpoint,
  RuntimeTabIdentity,
  WindowSnapshot,
} from '../../domain/archive/models';
import { attachPageProgress, PROGRESS_MAX_AGE_MS } from '../../domain/archive/page-progress';
import type { TabStashDatabase } from './database';

/** 网页进度只保存在当前会话的标签检查点中，正式归档由显式合并产生。 */
export class PageProgressRepository {
  /** @param db 与窗口影子和归档共享事务数据库。 */
  constructor(private readonly db: TabStashDatabase) {}

  /** @param checkpoint 已校验来源和数据上限的顶层页面检查点。 */
  async save(checkpoint: PageProgressCheckpoint): Promise<void> {
    await this.db.transaction('rw', this.db.pageProgress, async () => {
      const key: [string, number] = [checkpoint.sessionId, checkpoint.tabId];
      const previous = await this.db.pageProgress.get(key);
      if (!previous || previous.updatedAt <= checkpoint.updatedAt)
        await this.db.pageProgress.put(checkpoint);
    });
  }

  /**
   * 读取对应标签检查点并加入窗口快照；缺失、过期和网址不匹配均保持原快照。
   * @param sessionId 浏览器当前会话。
   * @param snapshot 本次捕获的稳定窗口结构。
   * @param runtimeTabs 与 snapshot 同次捕获的运行时对应关系。
   */
  async attach(
    sessionId: string,
    snapshot: WindowSnapshot,
    runtimeTabs: readonly RuntimeTabIdentity[],
  ): Promise<WindowSnapshot> {
    const checkpoints = await this.db.pageProgress.bulkGet(
      runtimeTabs.map((entry): [string, number] => [sessionId, entry.tabId]),
    );
    return attachPageProgress(
      snapshot,
      runtimeTabs,
      checkpoints.filter((entry): entry is PageProgressCheckpoint => entry !== undefined),
    );
  }

  /** 过期数据与最早的超额数据一并清理，避免后台长期运行时无限增长。 */
  async prune(now = Date.now()): Promise<void> {
    await this.db.pageProgress
      .where('updatedAt')
      .below(now - PROGRESS_MAX_AGE_MS)
      .delete();
    const excess = (await this.db.pageProgress.count()) - 2000;
    if (excess > 0) {
      const oldest = await this.db.pageProgress.orderBy('updatedAt').limit(excess).toArray();
      await this.db.pageProgress.bulkDelete(oldest.map((entry) => [entry.sessionId, entry.tabId]));
    }
  }
}
