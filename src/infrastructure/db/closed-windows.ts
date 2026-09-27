import type { ClosedWindowRecord } from '../../domain/archive/models';
import { attachPageProgress } from '../../domain/archive/page-progress';
import type { CloseSuppression } from '../storage/session';
import type { TabStashDatabase } from './database';

/** 手动归档与普通关闭的保守去重时间窗，仅用于同一会话、同一来源窗口。 */
const RECENT_MANUAL_MS = 30_000;

/** 关闭事件仓储：事务内检查来源、归档存在性、去重、写入与消费影子。 */
export class ClosedWindowRepository {
  /** @param db 与归档仓储共用的数据库实例，所有消费步骤在一个事务完成。 */
  constructor(private readonly db: TabStashDatabase) {}

  /** @param record 首次观察到的关闭事件，重复事件不会改写当时开关。 */
  async record(record: ClosedWindowRecord): Promise<void> {
    await this.db.transaction('rw', this.db.closedWindows, async () => {
      if (!(await this.db.closedWindows.get([record.sessionId, record.windowId]))) {
        await this.db.closedWindows.add(record);
      }
    });
  }

  /** @returns 已明确收到关闭事件但尚未完成消费的记录，跨 Worker 重启可重试。 */
  async pending(): Promise<ClosedWindowRecord[]> {
    return this.db.closedWindows.where('state').equals('pending').toArray();
  }

  /** @returns 待处理和需人工核对数量；保留无法确定关闭时设置的事件。 */
  async counts(): Promise<{ pendingCount: number; reviewCount: number }> {
    return {
      pendingCount: await this.db.closedWindows.where('state').equals('pending').count(),
      reviewCount: await this.db.closedWindows.where('state').equals('needs-review').count(),
    };
  }

  /**
   * 把旧版本中因设置读取失败而停留在待核对状态的记录重新送入消费流程。
   *
   * 在同一事务中把未知设置固定为关闭，随后复用正常关闭处理的去重、
   * 操作回执核对及影子清理逻辑；缺少快照的记录不在本次修复范围内。
   *
   * @returns 本次重新排队的旧记录数量。
   */
  async requeueUnknownSettings(): Promise<number> {
    return this.db.transaction('rw', this.db.closedWindows, async () => {
      const reviews = await this.db.closedWindows.where('state').equals('needs-review').toArray();
      let requeued = 0;
      for (const record of reviews) {
        if (record.enabled !== null) continue;
        // 保留关闭时刻和来源标识，只把无法确认的开关值改为用户指定的关闭策略。
        await this.db.closedWindows.put({ ...record, enabled: false, state: 'pending' });
        requeued += 1;
      }
      return requeued;
    });
  }

  /**
   * 原子消费影子并核对对应关闭日志，只有全部持久化成功才清理影子。
   * @param sessionId 事件所属会话，不使用当前会话替换旧事件身份。
   * @param windowId 明确关闭的来源窗口。
   * @param suppression 当前会话中仍有效的短时抑制，须与已保存归档核对。
   */
  async consume(
    sessionId: string,
    windowId: number,
    suppression?: CloseSuppression,
  ): Promise<ClosedWindowRecord | undefined> {
    return this.db.transaction(
      'rw',
      [
        this.db.closedWindows,
        this.db.archives,
        this.db.receipts,
        this.db.operations,
        this.db.shadows,
        this.db.pageProgress,
      ],
      async () => {
        const key: [string, number] = [sessionId, windowId];
        const record = await this.db.closedWindows.get(key);
        if (record?.state !== 'pending') return record;
        // 兼容旧版本尚未消费的 null 记录，统一按自动归档关闭处理。
        const enabled = record.enabled ?? false;
        const normalizedRecord = record.enabled === null ? { ...record, enabled } : record;
        const shadow = await this.db.shadows.get(key);
        const receipts = await this.db.receipts.where('[sessionId+windowId]').equals(key).toArray();
        let duplicateId: string | undefined;
        for (const receipt of receipts) {
          const archive = await this.db.archives.get(receipt.archiveId);
          if (!archive) continue;
          const operation = await this.db.operations.get(receipt.requestId);
          const closeRequested =
            operation?.type === 'archive-close' &&
            operation.sessionId === sessionId &&
            operation.windowId === windowId &&
            operation.archiveId === archive.id &&
            operation.state === 'close-requested';
          const suppressed =
            suppression?.sessionId === sessionId &&
            suppression.windowId === windowId &&
            suppression.archiveId === archive.id &&
            suppression.operationId === receipt.requestId;
          if (
            receipt.closeAfterArchive &&
            (receipt.outcome === 'closed' || closeRequested || suppressed)
          ) {
            duplicateId = archive.id;
            // 关闭事件是确认已关闭的证据；只有匹配本次请求的日志才可清理。
            const completed = { ...receipt, outcome: 'closed' as const };
            delete completed.warning;
            await this.db.receipts.put(completed);
            if (closeRequested) await this.db.operations.delete(receipt.requestId);
            break;
          }
          if (
            shadow &&
            archive.snapshotHash === shadow.snapshotHash &&
            Math.abs(record.closedAt - receipt.savedAt) <= RECENT_MANUAL_MS
          )
            duplicateId = archive.id;
        }
        let result: ClosedWindowRecord;
        if (duplicateId)
          result = {
            ...normalizedRecord,
            state: 'done',
            outcome: 'duplicate',
            archiveId: duplicateId,
          };
        else if (!enabled) result = { ...normalizedRecord, state: 'done', outcome: 'disabled' };
        else if (!shadow) {
          result = { ...normalizedRecord, state: 'needs-review', outcome: 'missing-shadow' };
        } else {
          const archiveId = crypto.randomUUID();
          const checkpoints = await this.db.pageProgress.bulkGet(
            (shadow.runtimeTabs ?? []).map((entry): [string, number] => [
              record.sessionId,
              entry.tabId,
            ]),
          );
          await this.db.archives.add({
            id: archiveId,
            archivedAt: record.closedAt,
            pinned: false,
            source: 'auto-close',
            snapshotHash: shadow.snapshotHash,
            snapshot: attachPageProgress(
              shadow.snapshot,
              shadow.runtimeTabs ?? [],
              checkpoints.filter((entry) => entry !== undefined),
              record.closedAt + 2000,
            ),
          });
          result = { ...normalizedRecord, state: 'done', outcome: 'archived', archiveId };
        }
        await this.db.closedWindows.put(result);
        if (result.state === 'done') {
          await this.db.shadows.delete(key);
          if (shadow?.runtimeTabs?.length)
            await this.db.pageProgress.bulkDelete(
              shadow.runtimeTabs.map((entry): [string, number] => [record.sessionId, entry.tabId]),
            );
        }
        return result;
      },
    );
  }
}
