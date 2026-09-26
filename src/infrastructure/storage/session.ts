import type { StorageArea } from './settings';

const SESSION_KEY = 'tabstash.session.v1';
const SUPPRESSION_PREFIX = 'tabstash.close-suppression.v1.';

/** 短时关闭抑制必须绑定会话和已保存归档，不能仅凭 windowId 跳过自动归档。 */
export interface CloseSuppression {
  sessionId: string;
  windowId: number;
  archiveId: string;
  operationId: string;
  expiresAt: number;
}

/**
 * 管理可跨 Worker 重启的会话标识和短时抑制；关键操作进度仍存 IndexedDB。
 *
 * 该对象仅由 Background 使用，避免多个侧栏同时初始化 session ID。
 */
export class SessionStore {
  private sessionRequest: Promise<string> | undefined;

  /** @param area 浏览器 storage.session 或测试存储。 */
  constructor(private readonly area: StorageArea) {}

  /** @returns 同一扩展会话的标识；存储失败后可重试，不永久缓存失败 Promise。 */
  getSessionId(): Promise<string> {
    if (!this.sessionRequest) {
      this.sessionRequest = this.readOrCreateSession().catch((error: unknown) => {
        this.sessionRequest = undefined;
        throw error;
      });
    }
    return this.sessionRequest;
  }

  /** 先读取会话存储；只有不存在时才生成新标识，并等待写入确认。 */
  private async readOrCreateSession(): Promise<string> {
    const existing = (await this.area.get(SESSION_KEY))[SESSION_KEY];
    if (existing !== undefined) {
      if (typeof existing !== 'string' || !existing) throw new Error('会话标识格式无效');
      return existing;
    }
    const id = crypto.randomUUID();
    await this.area.set({ [SESSION_KEY]: id });
    return id;
  }

  /** @param record 归档已经提交后创建的短时抑制记录。 */
  async saveSuppression(record: CloseSuppression): Promise<void> {
    if (record.sessionId !== (await this.getSessionId()) || !Number.isFinite(record.expiresAt)) {
      throw new Error('关闭抑制记录不属于当前会话或有效期无效');
    }
    await this.area.set({ [SUPPRESSION_PREFIX + record.windowId]: record });
  }

  /**
   * 读取仍有效的关闭抑制记录；过期、旧会话或损坏的记录不作为抑制依据。
   *
   * @param windowId 即将处理关闭事件的窗口。
   * @param now 当前时间，可在测试中指定过期边界。
   */
  async getSuppression(windowId: number, now = Date.now()): Promise<CloseSuppression | undefined> {
    const raw = (await this.area.get(SUPPRESSION_PREFIX + windowId))[SUPPRESSION_PREFIX + windowId];
    if (typeof raw !== 'object' || raw === null) return undefined;
    const record = raw as Partial<CloseSuppression>;
    if (
      record.sessionId !== (await this.getSessionId()) ||
      record.windowId !== windowId ||
      typeof record.archiveId !== 'string' ||
      !record.archiveId ||
      typeof record.operationId !== 'string' ||
      !record.operationId ||
      typeof record.expiresAt !== 'number' ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= now
    )
      return undefined;
    return record as CloseSuppression;
  }

  /** @param windowId 已完成关闭核对的窗口，清理对应短时记录。 */
  async removeSuppression(windowId: number): Promise<void> {
    await this.area.remove(SUPPRESSION_PREFIX + windowId);
  }
}
