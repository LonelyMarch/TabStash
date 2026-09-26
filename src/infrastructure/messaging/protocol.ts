import { defineExtensionMessaging } from '@webext-core/messaging';
import type { AppearanceMode } from '../../domain/appearance';
import type {
  ArchiveCommand,
  ArchivedWindow,
  ArchiveReceipt,
  AutoArchiveStatus,
  PersistenceStatus,
  RestoreCommand,
  RestoreJob,
  Settings,
  SnapshotStatus,
} from '../../domain/archive/models';
import type { LiveWindow } from '../../domain/window/live-tree';

/** Side Panel 与 Background 之间已实现的请求和失效通知协议。 */
interface ProtocolMap {
  getAppearance(): AppearanceMode;
  setAppearance(input: { mode: AppearanceMode }): AppearanceMode;
  appearanceInvalidated(): void;
  setArchivePinned(input: { archiveId: string; pinned: boolean }): void;
  deleteArchive(input: { archiveId: string }): boolean;
  restoreArchive(command: RestoreCommand): RestoreJob;
  getRestoreIssues(): RestoreJob[];
  restoreStateInvalidated(): void;
  archiveWindow(command: ArchiveCommand): ArchiveReceipt;
  getArchives(): ArchivedWindow[];
  archivesInvalidated(): void;
  getLiveWindows(): LiveWindow[];
  liveStateInvalidated(): void;
  getPersistenceStatus(): PersistenceStatus;
  getSnapshotStatus(): SnapshotStatus;
  refreshSnapshots(): SnapshotStatus;
  snapshotStateInvalidated(): void;
  getSettings(): Settings;
  updateSettings(input: Partial<Settings>): Settings;
  settingsInvalidated(): void;
  autoArchiveInvalidated(): void;
  getAutoArchiveStatus(): AutoArchiveStatus;
  retryAutoArchive(): AutoArchiveStatus;
}

/**
 * 共享同一份类型化消息定义，避免 UI 与 Background 的命令名称和返回值漂移。
 *
 * 这里仅创建消息器；真正的浏览器监听器在 Background 入口中注册，以免 WXT
 * 读取入口配置时就执行浏览器 API。
 */
export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
