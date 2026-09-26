import type {
  LiveWindowShadow,
  RuntimeTabIdentity,
  WindowSnapshot,
} from '../domain/archive/models';
import { computeSnapshotHash } from '../domain/archive/snapshot';
import { type Diagnostic, diagnosticFromError } from '../i18n/core';

/** 可替换的捕获与持久化接口，便于验证关闭事件和写入事件交错。 */
export interface ShadowDependencies {
  capture(windowId: number): Promise<{
    snapshot: WindowSnapshot;
    runtimeTabs: RuntimeTabIdentity[];
  }>;
  getSessionId(): Promise<string>;
  save(shadow: LiveWindowShadow): Promise<void>;
  /** 保存完成或失败后通知 UI 重读状态，不触发新的捕获。 */
  onSettled?(): void;
}

/**
 * 合并实时事件并按窗口串行捕获，关闭中的窗口不再覆盖最后成功快照。
 *
 * 内存状态只管理当前任务；Worker 每次启动会重新扫描现存窗口，真正的影子
 * 保存在 IndexedDB 中。关闭前尚未完成写入的最新变化仍可能无法被捕获。
 */
export class ShadowTracker {
  private readonly closing = new Set<number>();
  private readonly revisions = new Map<number, number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly jobs = new Map<number, Promise<void>>();
  private readonly failures = new Map<number, Diagnostic>();

  /** @param dependencies 浏览器捕获、会话读取和数据库写入函数。 */
  constructor(private readonly dependencies: ShadowDependencies) {}

  /** @param windowId 发生标签、组或位置变化的窗口；合并 180ms 内的密集通知。 */
  schedule(windowId: number): void {
    if (windowId < 0 || this.closing.has(windowId)) return;
    // 立即作废进行中的旧捕获，不能等到去抖结束才发现它已过时。
    this.revisions.set(windowId, (this.revisions.get(windowId) ?? 0) + 1);
    clearTimeout(this.timers.get(windowId));
    this.timers.set(
      windowId,
      setTimeout(() => {
        this.timers.delete(windowId);
        void this.refresh(windowId);
      }, 180),
    );
  }

  /**
   * 立即排队刷新一个窗口，失败时保留旧影子并记录可显示的错误。
   *
   * @param windowId 当前会话中的窗口 ID。
   * @returns 本次刷新完成时解析，具体失败通过 getFailures 读取。
   */
  refresh(windowId: number): Promise<void> {
    if (this.closing.has(windowId)) return Promise.resolve();
    clearTimeout(this.timers.get(windowId));
    this.timers.delete(windowId);
    const revision = (this.revisions.get(windowId) ?? 0) + 1;
    this.revisions.set(windowId, revision);
    const isCurrent = () =>
      !this.closing.has(windowId) && this.revisions.get(windowId) === revision;
    const task = (this.jobs.get(windowId) ?? Promise.resolve()).then(async () => {
      if (!isCurrent()) return;
      try {
        const sessionId = await this.dependencies.getSessionId();
        const { snapshot, runtimeTabs } = await this.dependencies.capture(windowId);
        const snapshotHash = await computeSnapshotHash(snapshot);
        if (!isCurrent()) return;
        await this.dependencies.save({
          sessionId,
          runtimeWindowId: windowId,
          updatedAt: Date.now(),
          snapshotHash,
          snapshot,
          runtimeTabs,
        });
        if (isCurrent()) this.failures.delete(windowId);
      } catch (error: unknown) {
        if (isCurrent())
          this.failures.set(windowId, diagnosticFromError(error, 'diagnosticShadowFailed'));
      } finally {
        if (isCurrent()) this.dependencies.onSettled?.();
      }
    });
    this.jobs.set(windowId, task);
    void task.finally(() => {
      if (this.jobs.get(windowId) === task) this.jobs.delete(windowId);
    });
    return task;
  }

  /**
   * 冻结整窗关闭后的影子，取消待处理任务；不删除持久影子，供自动归档阶段读取。
   *
   * @param windowId tabs.onRemoved(isWindowClosing) 或 windows.onRemoved 的窗口。
   */
  markClosing(windowId: number): void {
    this.closing.add(windowId);
    clearTimeout(this.timers.get(windowId));
    this.timers.delete(windowId);
    this.failures.delete(windowId);
  }

  /** @param windowId 关闭窗口；等待已发出的写入结束后才能消费并删除影子。 */
  async settleClosing(windowId: number): Promise<void> {
    this.markClosing(windowId);
    await this.jobs.get(windowId);
  }

  /** @param windowId 新建的窗口，用于防御同一会话内可能发生的 ID 复用。 */
  markCreated(windowId: number): void {
    this.closing.delete(windowId);
    this.schedule(windowId);
  }

  /** @param windowIds 当前窗口集合，过滤已经关闭窗口的错误提示。 */
  getFailures(windowIds: readonly number[]): Diagnostic[] {
    return windowIds.flatMap((id) => {
      const message = this.failures.get(id);
      return message ? [message] : [];
    });
  }
}
