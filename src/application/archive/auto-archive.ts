import type { AutoArchiveStatus, ClosedWindowRecord } from '../../domain/archive/models';
import { type Diagnostic, diagnosticFromError } from '../../i18n/core';
import type { ClosedWindowRepository } from '../../infrastructure/db/closed-windows';
import type { CloseSuppression, SessionStore } from '../../infrastructure/storage/session';
import type { SettingsStore } from '../../infrastructure/storage/settings';

/** 可注入的关闭消费依赖；等待正在保存的快照及手动归档，避免两条流程竞态。 */
interface Dependencies {
  repository: ClosedWindowRepository;
  session: Pick<SessionStore, 'getSessionId' | 'getSuppression' | 'removeSuppression'>;
  settings: Pick<SettingsStore, 'get'>;
  settle(windowId: number): Promise<void>;
  changed(): void;
}

/** 自动归档只处理已记录的关闭事实；不会主动关闭窗口或从旧 runtime ID 重放操作。 */
export class AutoArchiveService {
  private error: Diagnostic | null = null;
  private readonly jobs = new Map<string, Promise<void>>();

  /** @param dependencies 关闭事件仓储、设置、会话与后台任务协调器。 */
  constructor(private readonly dependencies: Dependencies) {}

  /**
   * 记录关闭时的设置后消费影子；设置读取失败时保留事件和影子供核对。
   * @param windowId 浏览器已明确关闭的窗口。
   */
  async onClosed(windowId: number): Promise<void> {
    try {
      const closedAt = Date.now();
      const sessionId = await this.dependencies.session.getSessionId();
      let enabled: boolean | null = null;
      try {
        enabled = (await this.dependencies.settings.get()).autoArchiveClosedWindows;
      } catch (error: unknown) {
        this.error = diagnosticFromError(error, 'diagnosticAutoArchiveSettings');
      }
      const record: ClosedWindowRecord = {
        sessionId,
        windowId,
        closedAt,
        enabled,
        state: 'pending',
      };
      await this.dependencies.repository.record(record);
      await this.process(record);
    } catch (error: unknown) {
      this.error = diagnosticFromError(error, 'diagnosticAutoArchiveFailed');
    }
    this.dependencies.changed();
  }

  /**
   * 消费一个持久关闭事件；同一进程的重复事件共享任务，数据库事务负责跨重启幂等。
   * @param record 等待核对的关闭事件。
   */
  private process(record: ClosedWindowRecord): Promise<void> {
    const key = `${record.sessionId}:${record.windowId}`;
    const existing = this.jobs.get(key);
    if (existing) return existing;
    const task = (async () => {
      const currentSession = await this.dependencies.session.getSessionId();
      let suppression: CloseSuppression | undefined;
      if (record.sessionId === currentSession) {
        await this.dependencies.settle(record.windowId);
        suppression = await this.dependencies.session.getSuppression(record.windowId);
      }
      const result = await this.dependencies.repository.consume(
        record.sessionId,
        record.windowId,
        suppression,
      );
      if (result?.state === 'done' && record.sessionId === currentSession) {
        await this.dependencies.session.removeSuppression(record.windowId);
      }
    })().finally(() => {
      this.jobs.delete(key);
    });
    this.jobs.set(key, task);
    return task;
  }

  /** 仅重试持久记录中的关闭事件；不根据当前设置补归档无关闭证据的旧窗口。 */
  async reconcile(): Promise<AutoArchiveStatus> {
    this.error = null;
    try {
      const pending = await this.dependencies.repository.pending();
      for (const record of pending) {
        try {
          await this.process(record);
        } catch (error: unknown) {
          this.error = diagnosticFromError(error, 'diagnosticAutoArchiveRetry');
        }
      }
    } catch (error: unknown) {
      this.error = diagnosticFromError(error, 'diagnosticClosedRead');
    }
    this.dependencies.changed();
    return this.status();
  }

  /** @returns 当前待处理、待核对数量及最近错误。 */
  async status(): Promise<AutoArchiveStatus> {
    return { ...(await this.dependencies.repository.counts()), error: this.error };
  }
}
