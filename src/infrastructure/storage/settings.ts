import type { Settings } from '../../domain/archive/models';

/** storage.local 与 storage.session 所需的最小接口，便于注入失败场景测试。 */
export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

const SETTINGS_KEY = 'tabstash.settings.v1';

/** 本地设置读取与写入；不吞掉权限、配额或数据损坏错误。 */
export class SettingsStore {
  /** @param area 浏览器 storage.local 或测试存储。 */
  constructor(private readonly area: StorageArea) {}

  /** @returns 已保存设置；仅在键不存在时返回默认值，不把读取失败当作默认值。 */
  async get(): Promise<Settings> {
    const raw = (await this.area.get(SETTINGS_KEY))[SETTINGS_KEY];
    if (raw === undefined) return { autoArchiveClosedWindows: false };
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('autoArchiveClosedWindows' in raw) ||
      typeof raw.autoArchiveClosedWindows !== 'boolean'
    ) {
      throw new Error('本地设置格式无效，未覆盖原有数据');
    }
    return { autoArchiveClosedWindows: raw.autoArchiveClosedWindows };
  }

  /**
   * 校验后持久化设置；只有 storage.local.set 成功后才向调用方报告成功。
   *
   * @param input 设置更新字段；当前唯一字段为自动归档开关。
   * @returns 已确认写入的完整设置。
   */
  async update(input: Partial<Settings>): Promise<Settings> {
    if (
      Object.keys(input).some((key) => key !== 'autoArchiveClosedWindows') ||
      ('autoArchiveClosedWindows' in input && typeof input.autoArchiveClosedWindows !== 'boolean')
    ) {
      throw new Error('设置更新参数无效');
    }
    const settings =
      'autoArchiveClosedWindows' in input
        ? { autoArchiveClosedWindows: input.autoArchiveClosedWindows as boolean }
        : await this.get();
    await this.area.set({ [SETTINGS_KEY]: settings });
    return settings;
  }
}
