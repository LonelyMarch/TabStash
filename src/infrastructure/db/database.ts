import Dexie, { type Table } from 'dexie';
import type {
  ArchivedWindow,
  ArchiveReceipt,
  ClosedWindowRecord,
  LiveWindowShadow,
  PageProgressCheckpoint,
  PendingOperation,
  RestoreJob,
} from '../../domain/archive/models';
import type { Diagnostic } from '../../i18n/core';

/** v0.1.0 将诊断句子直接写入回执；升级时只在事务内处理这两种旧字段。 */
type LegacyArchiveReceipt = Omit<ArchiveReceipt, 'warning'> & { warning?: Diagnostic | string };
type LegacyRestoreJob = Omit<RestoreJob, 'errors' | 'progressWarnings'> & {
  errors: (Diagnostic | string)[];
  progressWarnings?: (Diagnostic | string)[];
};

/** @param value 旧版句子或新版诊断。@returns 保留旧句子内容的结构化诊断。 */
function normalizeStoredDiagnostic(value: Diagnostic | string): Diagnostic {
  return typeof value === 'string' ? { key: 'diagnosticLegacy', params: { detail: value } } : value;
}

/**
 * 定义 TabStash 的持久数据库；创建实例不执行浏览器 API，也不删除旧数据。
 *
 * v1 是首个持久化版本。以后升级必须追加 version(n)，不能修改既有版本号
 * 或在打开失败时删库重建。IndexedDB 升级事务失败由调用方展示原始错误。
 */
export class TabStashDatabase extends Dexie {
  archives!: Table<ArchivedWindow, string>;
  shadows!: Table<LiveWindowShadow, [string, number]>;
  operations!: Table<PendingOperation, string>;
  receipts!: Table<ArchiveReceipt, string>;
  closedWindows!: Table<ClosedWindowRecord, [string, number]>;
  restoreJobs!: Table<RestoreJob, string>;
  pageProgress!: Table<PageProgressCheckpoint, [string, number]>;

  /**
   * 创建数据库对象；允许测试传入独立名称，生产使用固定名称。
   *
   * @param name IndexedDB 数据库名称，不包含临时运行时 ID。
   */
  constructor(name = 'TabStash') {
    super(name);
    this.version(1).stores({
      // 不索引整个快照或布尔值；索引只服务于列表、时间和来源检索。
      archives: '&id, archivedAt, pinnedAt, source',
      shadows: '[sessionId+runtimeWindowId], sessionId, updatedAt',
      operations: '&id, sessionId, type, state, startedAt',
    });
    // v2 仅新增请求回执，升级时保留 v1 的归档、影子与操作日志。
    this.version(2).stores({ receipts: '&requestId, [sessionId+windowId], savedAt' });
    // v3 记录明确收到的关闭事件，不能仅根据旧影子猜测窗口已经关闭。
    this.version(3).stores({ closedWindows: '[sessionId+windowId], state, closedAt' });
    // v4 持久记录恢复进度，完整成功与移除原归档在同一事务提交。
    this.version(4).stores({ restoreJobs: '&requestId, archiveId, state, startedAt' });
    // v5 只新增会话内网页进度检查点；已有归档缺少 progress 字段时直接按旧格式读取。
    this.version(5).stores({ pageProgress: '[sessionId+tabId], updatedAt, windowId' });
    // v6 在同一升级事务中规范化旧版字符串诊断；不删除归档、回执或恢复进度。
    this.version(6)
      .stores({})
      .upgrade(async (transaction) => {
        await transaction
          .table('receipts')
          .toCollection()
          .modify((receipt: LegacyArchiveReceipt) => {
            if (typeof receipt.warning === 'string') {
              receipt.warning = normalizeStoredDiagnostic(receipt.warning);
            }
          });
        await transaction
          .table('restoreJobs')
          .toCollection()
          .modify((job: LegacyRestoreJob) => {
            job.errors = job.errors.map(normalizeStoredDiagnostic);
            if (job.progressWarnings) {
              job.progressWarnings = job.progressWarnings.map(normalizeStoredDiagnostic);
            }
          });
      });
  }
}
