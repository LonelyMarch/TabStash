import type { TabStashDatabase } from './database';

/** 只管理归档元数据与显式删除，不能修改快照或关闭任何浏览器窗口。 */
export class ArchiveManagementRepository {
  /** @param db 与恢复和归档用例共用的持久数据库。 */
  constructor(private readonly db: TabStashDatabase) {}

  /**
   * 设置置顶状态；重复请求不刷新 pinnedAt，保留首次置顶时间记录，该时间不参与排序。
   * @param archiveId 归档身份。
   * @param pinned 目标置顶状态。
   */
  async setPinned(archiveId: string, pinned: boolean): Promise<void> {
    if (typeof archiveId !== 'string' || !archiveId || typeof pinned !== 'boolean')
      throw new Error('置顶参数无效');
    await this.db.transaction('rw', this.db.archives, async () => {
      const archive = await this.db.archives.get(archiveId);
      if (!archive) throw new Error('归档不存在，请刷新列表');
      if (archive.pinned === pinned) return;
      const updated = { ...archive, pinned };
      if (pinned) updated.pinnedAt = Date.now();
      else delete updated.pinnedAt;
      await this.db.archives.put(updated);
    });
  }

  /**
   * 用户确认后删除单个归档；事务内检查恢复和关闭操作，避免其他面板并发操作丢数据。
   * @param archiveId 明确确认要删除的归档 ID。
   * @returns 是否实际删除；重复请求目标不存在时按幂等成功处理。
   */
  async delete(archiveId: string): Promise<boolean> {
    if (typeof archiveId !== 'string' || !archiveId) throw new Error('删除参数无效');
    return this.db.transaction(
      'rw',
      this.db.archives,
      this.db.restoreJobs,
      this.db.operations,
      async () => {
        if (!(await this.db.archives.get(archiveId))) return false;
        const running = await this.db.restoreJobs
          .where('archiveId')
          .equals(archiveId)
          .filter((job) => job.state === 'running')
          .count();
        const pending = await this.db.operations
          .filter((operation) => operation.archiveId === archiveId)
          .count();
        if (running || pending) throw new Error('此归档仍有进行中或待核对的操作，暂时不能删除');
        await this.db.archives.delete(archiveId);
        // 保留幂等回执与关闭记录，防止旧请求重试把已经删除的归档重新生成。
        return true;
      },
    );
  }
}
