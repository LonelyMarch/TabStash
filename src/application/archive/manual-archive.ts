import type {
  ArchiveCommand,
  ArchiveReceipt,
  PendingOperation,
  WindowSnapshot,
} from '../../domain/archive/models';
import { computeSnapshotHash } from '../../domain/archive/snapshot';
import { AppError, diagnosticFromError } from '../../i18n/core';
import type { ArchiveRepository } from '../../infrastructure/db/repository';
import type { SessionStore } from '../../infrastructure/storage/session';

/** 归档用例仅依赖窄接口，测试可模拟浏览器关闭失败和存储故障。 */
interface Dependencies {
  repository: Pick<
    ArchiveRepository,
    'getReceipt' | 'commitManualArchive' | 'finishManualArchive' | 'saveOperation'
  >;
  session: Pick<SessionStore, 'getSessionId' | 'saveSuppression' | 'removeSuppression'>;
  capture(windowId: number): Promise<WindowSnapshot>;
  close(windowId: number): Promise<void>;
  changed(): void;
}

/** 负责每窗口互斥、持久幂等与先保存后关闭；绝不从旧请求自动重放关闭。 */
export class ManualArchiveService {
  private readonly active = new Map<
    number,
    { command: ArchiveCommand; task: Promise<ArchiveReceipt> }
  >();

  /** @param dependencies 数据库、浏览器和通知适配器。 */
  constructor(private readonly dependencies: Dependencies) {}

  /** @param windowId 等待此窗口正在执行的手动归档，供关闭事件消费流程核对持久回执。 */
  async settle(windowId: number): Promise<void> {
    try {
      await this.active.get(windowId)?.task;
    } catch {
      /* 手动操作失败后由关闭流程检查旧影子。 */
    }
  }

  /**
   * 执行用户归档操作；相同请求共享执行结果，不同请求不能同时处理同一窗口。
   * @param command 消息传来的请求，运行时也校验字段，不能只依赖 TS 类型。
   */
  execute(command: ArchiveCommand): Promise<ArchiveReceipt> {
    if (
      !command ||
      typeof command.requestId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(command.requestId) ||
      !Number.isSafeInteger(command.windowId) ||
      command.windowId < 0 ||
      typeof command.closeAfterArchive !== 'boolean'
    ) {
      return Promise.reject(new Error('归档请求参数无效'));
    }
    const current = this.active.get(command.windowId);
    if (current) {
      if (
        current.command.requestId === command.requestId &&
        current.command.closeAfterArchive === command.closeAfterArchive
      )
        return current.task;
      return Promise.reject(new Error('此窗口正在归档，请等待完成'));
    }
    const task = this.run(command).finally(() => {
      this.active.delete(command.windowId);
    });
    this.active.set(command.windowId, { command, task });
    return task;
  }

  /**
   * 保存完整归档，再执行可选关闭；后半段失败返回“已保存”的回执与警告。
   * @param command 已校验的用户请求。
   */
  private async run(command: ArchiveCommand): Promise<ArchiveReceipt> {
    const { repository, session, capture, close, changed } = this.dependencies;
    const previous = await repository.getReceipt(command.requestId);
    if (previous) {
      if (
        previous.windowId !== command.windowId ||
        previous.closeAfterArchive !== command.closeAfterArchive
      )
        throw new Error('请求 ID 已用于其他操作');
      // 已保存但没有最终关闭回执，可能是 Worker 中断；返回原归档并提示核对，绝不重放关闭。
      return previous.closeAfterArchive && previous.outcome === 'saved'
        ? { ...previous, warning: { key: 'diagnosticArchiveSavedCloseUnknown' } }
        : previous;
    }
    const sessionId = await session.getSessionId();
    const snapshot = await capture(command.windowId);
    const snapshotHash = await computeSnapshotHash(snapshot);
    const savedAt = Date.now();
    const receipt: ArchiveReceipt = {
      ...command,
      sessionId,
      archiveId: crypto.randomUUID(),
      savedAt,
      outcome: 'saved',
    };
    const operation: PendingOperation = {
      id: command.requestId,
      type: 'archive-close',
      sessionId,
      windowId: command.windowId,
      archiveId: receipt.archiveId,
      state: 'archive-written',
      startedAt: savedAt,
    };
    await repository.commitManualArchive(
      {
        id: receipt.archiveId,
        archivedAt: savedAt,
        pinned: false,
        source: command.closeAfterArchive ? 'manual-close' : 'manual',
        snapshotHash,
        snapshot,
      },
      receipt,
      command.closeAfterArchive ? operation : undefined,
    );
    changed();
    if (!command.closeAfterArchive) return receipt;

    let closed = false;
    try {
      // 写入期间窗口可能新增标签；检测到结构变化时保留归档，但停止关闭。
      const latest = await capture(command.windowId);
      if ((await computeSnapshotHash(latest)) !== snapshotHash)
        throw new AppError({ key: 'diagnosticWindowChanged' });
      if (snapshot.tabs.some((tab) => !tab.url))
        throw new AppError({ key: 'diagnosticMissingUrl' });
      await session.saveSuppression({
        sessionId,
        windowId: command.windowId,
        archiveId: receipt.archiveId,
        operationId: command.requestId,
        expiresAt: Date.now() + 30_000,
      });
      await repository.saveOperation({ ...operation, state: 'close-requested' });
      await close(command.windowId);
      closed = true;
      const completed: ArchiveReceipt = { ...receipt, outcome: 'closed' };
      await repository.finishManualArchive(completed);
      changed();
      return completed;
    } catch (error: unknown) {
      const cause = diagnosticFromError(error, 'diagnosticBrowser');
      // 窗口已关闭但回执写入失败时保留未完成日志，避免把关闭结果伪装成未关闭。
      const result: ArchiveReceipt = {
        ...receipt,
        outcome: closed ? 'closed' : 'close-failed',
        warning: closed
          ? { key: 'diagnosticClosedRecordReview' }
          : cause.key === 'diagnosticWindowChanged' || cause.key === 'diagnosticMissingUrl'
            ? cause
            : { key: 'diagnosticCloseFailed' },
      };
      if (!closed) {
        try {
          await session.removeSuppression(command.windowId);
          await repository.finishManualArchive(result);
        } catch {
          result.warning = { key: 'diagnosticCleanupFailed' };
        }
      }
      changed();
      return result;
    }
  }
}
