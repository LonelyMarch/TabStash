import type {
  PageProgress,
  PageProgressCheckpoint,
  RuntimeTabIdentity,
  WindowSnapshot,
} from './models';

export const PROGRESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 16 * 1024;

/**
 * 校验来自网页内容脚本的有限数据，阻止异常页面写入无限大或不可恢复的检查点。
 * @param value 不可信的网页进度消息。
 * @returns 可持久化的数据；无效消息返回 null。
 */
export function parsePageProgress(value: unknown): PageProgress | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<PageProgress>;
  if (
    typeof input.url !== 'string' ||
    input.url.length > 8192 ||
    !/^https?:\/\//.test(input.url) ||
    !Array.isArray(input.scrolls) ||
    input.scrolls.length > 21 ||
    !Array.isArray(input.media) ||
    input.media.length > 4
  )
    return null;
  const validPath = (path: unknown) =>
    typeof path === 'string' && path.length > 0 && path.length <= 240;
  const validPosition = (position: unknown) =>
    typeof position === 'number' && Number.isFinite(position) && position >= 0;
  for (const scroll of input.scrolls) {
    if (
      !scroll ||
      !validPath(scroll.path) ||
      !validPosition(scroll.top) ||
      !validPosition(scroll.left) ||
      !validPosition(scroll.maxTop) ||
      !validPosition(scroll.maxLeft)
    )
      return null;
  }
  for (const media of input.media) {
    if (
      !media ||
      !validPath(media.path) ||
      !['audio', 'video'].includes(media.kind) ||
      !validPosition(media.time) ||
      !validPosition(media.duration) ||
      media.duration <= 0 ||
      media.time > media.duration
    )
      return null;
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_BYTES) return null;
  return input as PageProgress;
}

/**
 * 按稳定快照键和原标签 ID 合并检查点；网址不一致时绝不套用旧页面位置。
 * @param snapshot 不含运行时 ID 的窗口快照。
 * @param runtimeTabs 同次捕获取得的标签 ID 对应关系。
 * @param checkpoints 已读取的当前会话检查点。
 * @param now 比较检查点有效期的时间。
 */
export function attachPageProgress(
  snapshot: WindowSnapshot,
  runtimeTabs: readonly RuntimeTabIdentity[],
  checkpoints: readonly PageProgressCheckpoint[],
  now = Date.now(),
): WindowSnapshot {
  const ids = new Map(runtimeTabs.map((entry) => [entry.key, entry.tabId]));
  const byId = new Map(checkpoints.map((entry) => [entry.tabId, entry]));
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => {
      const checkpoint = byId.get(ids.get(tab.key) ?? -1);
      if (
        !checkpoint ||
        checkpoint.progress.url !== tab.url ||
        checkpoint.updatedAt > now ||
        now - checkpoint.updatedAt > PROGRESS_MAX_AGE_MS
      )
        return tab;
      return { ...tab, progress: checkpoint.progress };
    }),
  };
}
