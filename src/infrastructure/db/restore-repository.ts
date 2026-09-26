import type { ArchivedWindow, RestoreCommand, RestoreJob } from '../../domain/archive/models';
import type { TabStashDatabase } from './database';

/** 恢复进度仓储，只有明确完成的恢复才能在事务中移除归档。 */
export class RestoreRepository {
  /** @param db 与归档仓储共享的数据库。 */
  constructor(private readonly db: TabStashDatabase) {}

  /** @param requestId 原请求 ID，消息重试读取同一回执。 */
  async get(requestId: string): Promise<RestoreJob | undefined> {
    return this.db.restoreJobs.get(requestId);
  }

  /**
   * 在创建浏览器窗口之前保存操作意图并检查同一归档是否正在恢复。
   * @param command 用户请求。
   * @param sessionId 当前浏览器会话。
   */
  async begin(
    command: RestoreCommand,
    sessionId: string,
  ): Promise<{ archive: ArchivedWindow; job: RestoreJob }> {
    return this.db.transaction(
      'rw',
      this.db.archives,
      this.db.restoreJobs,
      this.db.operations,
      async () => {
        const archive = await this.db.archives.get(command.archiveId);
        if (!archive) throw new Error('归档不存在，请刷新列表');
        const active = await this.db.restoreJobs
          .where('archiveId')
          .equals(command.archiveId)
          .filter((job) => job.state === 'running')
          .count();
        if (active) throw new Error('此归档已有恢复任务，请等待完成或核对中断记录');
        const job: RestoreJob = {
          ...command,
          sessionId,
          startedAt: Date.now(),
          state: 'running',
          tabs: [],
          groups: [],
          totalTabs: archive.snapshot.tabs.length,
          errors: [],
          archiveRemoved: false,
        };
        await this.db.restoreJobs.add(job);
        await this.db.operations.add({
          id: command.requestId,
          sessionId,
          startedAt: job.startedAt,
          type: command.removeAfterRestore ? 'restore-remove' : 'restore',
          archiveId: command.archiveId,
          state: 'started',
        });
        return { archive, job };
      },
    );
  }

  /** @param job 已创建窗口/标签/组后的进度；写入失败时由用例停止后续恢复。 */
  async save(job: RestoreJob): Promise<void> {
    await this.db.transaction('rw', this.db.restoreJobs, this.db.operations, async () => {
      await this.db.restoreJobs.put(job);
      await this.db.operations.put({
        id: job.requestId,
        sessionId: job.sessionId,
        startedAt: job.startedAt,
        type: job.removeAfterRestore ? 'restore-remove' : 'restore',
        archiveId: job.archiveId,
        ...(job.windowId === undefined ? {} : { restoredWindowId: job.windowId }),
        state: job.windowId === undefined ? 'started' : 'window-created',
      });
    });
  }

  /**
   * 完成回执与可选删除原归档同时提交；部分失败、映射缺失或中断一律保留归档。
   * @param job 已经过浏览器状态核对的最终结果。
   */
  async finish(job: RestoreJob): Promise<RestoreJob> {
    const complete =
      job.state === 'complete' &&
      job.errors.length === 0 &&
      job.windowId !== undefined &&
      job.totalTabs > 0 &&
      job.tabs.length === job.totalTabs;
    if (job.state === 'complete' && !complete) throw new Error('恢复完成条件不满足，已保留归档');
    const result = { ...job, archiveRemoved: complete && job.removeAfterRestore };
    await this.db.transaction(
      'rw',
      this.db.archives,
      this.db.restoreJobs,
      this.db.operations,
      async () => {
        if (result.archiveRemoved) await this.db.archives.delete(job.archiveId);
        await this.db.restoreJobs.put(result);
        await this.db.operations.delete(job.requestId);
      },
    );
    return result;
  }

  /**
   * Worker 新实例启动时将上次未完成任务标记为中断；绝不继续创建窗口或删除归档。
   * @returns 被标记的任务数，用于调试和测试启动核对。
   */
  async interruptUnfinished(): Promise<number> {
    return this.db.transaction('rw', this.db.restoreJobs, this.db.operations, async () => {
      const jobs = await this.db.restoreJobs.where('state').equals('running').toArray();
      for (const job of jobs) {
        await this.db.restoreJobs.put({
          ...job,
          state: 'interrupted',
          errors: [
            ...job.errors,
            '恢复被后台重启中断；已保留原归档和已创建窗口，请检查后重新恢复。',
          ],
        });
        // 中断已明确处理，进度保存在恢复回执；不留无限挂起的活动操作锁。
        await this.db.operations.delete(job.requestId);
      }
      return jobs.length;
    });
  }

  /** @returns 最近未完整完成的恢复记录，用于所有侧栏显示持久失败反馈。 */
  async issues(): Promise<RestoreJob[]> {
    return (await this.db.restoreJobs.where('state').anyOf('partial', 'interrupted').toArray())
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 5);
  }
}
