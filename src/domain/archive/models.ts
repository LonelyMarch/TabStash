import type { GroupColor } from '../window/live-tree';

/** 页面内滚动位置；document 表示主滚动区域，其余路径只描述 DOM 结构。 */
export interface ScrollProgress {
  path: string;
  top: number;
  left: number;
  maxTop: number;
  maxLeft: number;
}

/** 原生媒体的播放时间；不保存媒体地址、音量或播放状态。 */
export interface MediaProgress {
  path: string;
  kind: 'audio' | 'video';
  time: number;
  duration: number;
}

/** 单个顶层网页的尽力恢复数据，不包含表单、正文或登录信息。 */
export interface PageProgress {
  url: string;
  scrolls: ScrollProgress[];
  media: MediaProgress[];
}

/** 当前浏览器会话中的标签检查点；关闭窗口后可与影子快照合并。 */
export interface PageProgressCheckpoint {
  sessionId: string;
  tabId: number;
  windowId: number;
  updatedAt: number;
  progress: PageProgress;
}

/** 仅存于实时窗口影子的快照键与浏览器标签 ID 对应关系。 */
export interface RuntimeTabIdentity {
  key: string;
  tabId: number;
}

/** 归档中的标签使用快照内标识，不保存浏览器运行时 tabId。 */
export interface TabSnapshot {
  key: string;
  /** 未读取到 URL 时保留 null，恢复阶段应报告缺失而不是伪造空白页。 */
  url: string | null;
  title: string;
  favIconUrl?: string;
  index: number;
  pinned: boolean;
  groupKey?: string;
  progress?: PageProgress;
}

/** 组成员通过 TabSnapshot.groupKey 关联，避免运行时 groupId 被复用。 */
export interface GroupSnapshot {
  key: string;
  title?: string;
  color: GroupColor;
  collapsed: boolean;
}

/** 与浏览器会话无关的完整窗口快照，保存后不再跟随实时标签变化。 */
export interface WindowSnapshot {
  state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  activeTabKey?: string;
  tabs: TabSnapshot[];
  groups: GroupSnapshot[];
}

/** 归档元数据与不可变快照；置顶只改变元数据。 */
export interface ArchivedWindow {
  id: string;
  archivedAt: number;
  pinned: boolean;
  pinnedAt?: number;
  source: 'manual' | 'manual-close' | 'auto-close';
  snapshotHash: string;
  snapshot: WindowSnapshot;
}

/** 最近一次已持久化的实时窗口状态；会话标识防止重启后误认复用的窗口 ID。 */
export interface LiveWindowShadow {
  sessionId: string;
  runtimeWindowId: number;
  updatedAt: number;
  snapshotHash: string;
  snapshot: WindowSnapshot;
  runtimeTabs?: RuntimeTabIdentity[];
}

/** 持久操作日志跨 Worker 重启保留；旧会话记录只能核对，不能直接重放破坏性操作。 */
export type PendingOperation = {
  id: string;
  sessionId: string;
  startedAt: number;
} & (
  | {
      type: 'archive-close';
      windowId: number;
      archiveId?: string;
      state: 'started' | 'archive-written' | 'close-requested';
    }
  | {
      type: 'restore' | 'restore-remove';
      archiveId: string;
      restoredWindowId?: number;
      state: 'started' | 'window-created' | 'restore-complete';
    }
);

/** 用户设置默认关闭自动归档；功能接入前只提供存储，不执行自动归档。 */
export interface Settings {
  autoArchiveClosedWindows: boolean;
}

/** 面板读取存储状态，用于呈现错误与尚未核对的操作数量。 */
export interface PersistenceStatus {
  archiveCount: number;
  pendingOperationCount: number;
}

/** 最近一次窗口影子检查结果；窗口影子不是归档，不应计入归档数量。 */
export interface SnapshotStatus {
  windowCount: number;
  savedWindowCount: number;
  latestSavedAt: number | null;
  errors: string[];
}

/** 同一次用户操作的稳定请求 ID，用于跨消息重试去重。 */
export interface ArchiveCommand {
  requestId: string;
  windowId: number;
  closeAfterArchive: boolean;
}

/** 持久回执与归档同事务保存；Worker 重启后重试不会重新关闭窗口。 */
export interface ArchiveReceipt extends ArchiveCommand {
  sessionId: string;
  archiveId: string;
  savedAt: number;
  outcome: 'saved' | 'closed' | 'close-failed';
  warning?: string;
}

/** 持久关闭事件记录：先记关闭事实及当时开关，再消费影子，防止重启后重复或改变决策。 */
export interface ClosedWindowRecord {
  sessionId: string;
  windowId: number;
  closedAt: number;
  enabled: boolean | null;
  state: 'pending' | 'done' | 'needs-review';
  outcome?: 'archived' | 'duplicate' | 'disabled' | 'missing-shadow';
  archiveId?: string;
}

/** 自动归档检查反馈，不把失败或待核对状态伪装成成功。 */
export interface AutoArchiveStatus {
  pendingCount: number;
  reviewCount: number;
  error: string | null;
}

/** 恢复请求以稳定 ID 去重；新点击可创建新请求，消息重试不能重复创建窗口。 */
export interface RestoreCommand {
  requestId: string;
  archiveId: string;
  removeAfterRestore: boolean;
}

/** 恢复过程中记录快照 key 到新浏览器 ID 的映射，不修改原始归档。 */
export interface RestoredIdentity {
  key: string;
  id: number;
}

/** 持久恢复回执和进度；中断后保留归档，不根据旧运行时 ID 自动重放。 */
export interface RestoreJob extends RestoreCommand {
  sessionId: string;
  startedAt: number;
  state: 'running' | 'complete' | 'partial' | 'interrupted';
  windowId?: number;
  placeholderTabId?: number;
  tabs: RestoredIdentity[];
  groups: RestoredIdentity[];
  totalTabs: number;
  errors: string[];
  progressWarnings?: string[];
  archiveRemoved: boolean;
}
