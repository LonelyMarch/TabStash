import type {
  ArchivedWindow,
  ArchiveReceipt,
  LiveWindowShadow,
  PendingOperation,
  PersistenceStatus,
} from '../../domain/archive/models';
import { TabStashDatabase } from './database';

/**
 * 对数据库写入提供明确的事务边界；错误一律向上传递，禁止伪装保存成功。
 *
 * 构造时不打开数据库，Background 在收到命令时按需使用同一实例。
 */
export class ArchiveRepository {
  /** @param db 生产数据库或测试隔离数据库。 */
  constructor(private readonly db: TabStashDatabase = new TabStashDatabase()) {}

  /** 读取数据库状态；打开失败或读取失败时直接拒绝 Promise。 */
  async getStatus(): Promise<PersistenceStatus> {
    return this.db.transaction('r', this.db.archives, this.db.operations, async () => ({
      archiveCount: await this.db.archives.count(),
      pendingOperationCount: await this.db.operations.count(),
    }));
  }

  /** @returns 数据库中的归档；排序由后续归档列表领域规则负责。 */
  async getArchives(): Promise<ArchivedWindow[]> {
    return this.db.archives.toArray();
  }

  /** @param requestId 原始用户请求 ID，重试时读取原回执而非再次创建归档。 */
  async getReceipt(requestId: string): Promise<ArchiveReceipt | undefined> {
    return this.db.receipts.get(requestId);
  }

  /**
   * 原子提交手动归档、持久回执及可选关闭日志；任一写入失败则全部回滚。
   * @param archive 不可变窗口归档。
   * @param receipt 与本次请求绑定的回执。
   * @param operation 归档并关闭时的持久操作日志。
   */
  async commitManualArchive(
    archive: ArchivedWindow,
    receipt: ArchiveReceipt,
    operation?: PendingOperation,
  ): Promise<void> {
    if (
      receipt.archiveId !== archive.id ||
      receipt.outcome !== 'saved' ||
      (receipt.closeAfterArchive &&
        (operation?.type !== 'archive-close' ||
          operation.archiveId !== archive.id ||
          operation.id !== receipt.requestId))
    ) {
      throw new Error('归档回执或关闭日志不匹配');
    }
    await this.db.transaction(
      'rw',
      this.db.archives,
      this.db.receipts,
      this.db.operations,
      async () => {
        await this.db.archives.add(archive);
        await this.db.receipts.add(receipt);
        if (operation) await this.db.operations.add(operation);
      },
    );
  }

  /**
   * 完成已确认的操作并更新回执；只清理操作日志，不删除归档。
   * @param receipt 关闭成功或已确认未关闭的最终回执。
   */
  async finishManualArchive(receipt: ArchiveReceipt): Promise<void> {
    await this.db.transaction('rw', this.db.receipts, this.db.operations, async () => {
      await this.db.receipts.put(receipt);
      await this.db.operations.delete(receipt.requestId);
    });
  }

  /**
   * 新增不可变归档；相同 ID 重复写入会失败，不覆盖已保存的用户数据。
   *
   * @param archive 已完成捕获和 hash 计算的归档。
   */
  async addArchive(archive: ArchivedWindow): Promise<void> {
    await this.db.archives.add(archive);
  }

  /**
   * 同一事务内保存归档与“已保存、待关闭”的日志，供归档并关闭用例使用。
   *
   * @param archive 要持久化的归档。
   * @param operation 已关联该归档的 archive-close 操作。
   */
  async commitArchiveAndOperation(
    archive: ArchivedWindow,
    operation: PendingOperation,
  ): Promise<void> {
    if (
      operation.type !== 'archive-close' ||
      operation.state !== 'archive-written' ||
      operation.archiveId !== archive.id
    ) {
      throw new Error('归档与操作日志不匹配，已取消写入');
    }
    await this.db.transaction('rw', this.db.archives, this.db.operations, async () => {
      // 任意一步失败会回滚两张表；调用方只能在事务提交后请求关闭窗口。
      await this.db.archives.add(archive);
      await this.db.operations.put(operation);
    });
  }

  /** @param operation 当前关键操作进度；仅持久化，不在此处操作浏览器窗口。 */
  async saveOperation(operation: PendingOperation): Promise<void> {
    await this.db.operations.put(operation);
  }

  /** @returns 所有未核对操作，包括旧会话；不得在此阶段自动删除或重放。 */
  async getPendingOperations(): Promise<PendingOperation[]> {
    return this.db.operations.orderBy('startedAt').toArray();
  }

  /**
   * 更新当前会话的窗口影子；拒绝用较早完成的捕获覆盖较新的状态。
   *
   * @param shadow 最近一次成功捕获的非空窗口快照。
   */
  async saveShadow(shadow: LiveWindowShadow): Promise<void> {
    if (shadow.snapshot.tabs.length === 0) throw new Error('不能用空窗口覆盖最近保存的快照');
    await this.db.transaction('rw', this.db.shadows, async () => {
      const previous = await this.db.shadows.get([shadow.sessionId, shadow.runtimeWindowId]);
      if (previous && previous.updatedAt > shadow.updatedAt) return;
      await this.db.shadows.put(shadow);
    });
  }

  /**
   * 只读取当前会话中明确匹配的窗口，避免浏览器重启后 runtimeWindowId 复用。
   *
   * @param sessionId 当前扩展会话标识。
   * @param windowId 浏览器窗口运行时 ID。
   * @returns 最近成功持久化的影子；没有匹配记录时为 undefined。
   */
  async getShadow(sessionId: string, windowId: number): Promise<LiveWindowShadow | undefined> {
    return this.db.shadows.get([sessionId, windowId]);
  }
}
