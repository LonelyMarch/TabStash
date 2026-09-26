import { type AppearanceMode, isAppearanceMode } from '../../domain/appearance';
import type { StorageArea } from './settings';

/** 与自动归档设置隔离的外观存储键，避免改写旧设置对象。 */
export const APPEARANCE_KEY = 'tabstash.appearance.v1';

/** 持久保存所有侧栏共用的外观模式，读写失败保持原值并向界面报告。 */
export class AppearanceStore {
  /** @param area 浏览器 storage.local 或测试存储。 */
  constructor(private readonly area: Pick<StorageArea, 'get' | 'set'>) {}

  /** @returns 持久模式；首次使用返回自动模式，损坏数据抛错。 */
  async get(): Promise<AppearanceMode> {
    const value = (await this.area.get(APPEARANCE_KEY))[APPEARANCE_KEY];
    if (value === undefined) return 'auto';
    if (!isAppearanceMode(value)) throw new Error('本地外观设置格式无效');
    return value;
  }

  /** @param mode 用户选择的模式。@returns 写入确认后的模式。 */
  async set(mode: AppearanceMode): Promise<AppearanceMode> {
    if (!isAppearanceMode(mode)) throw new Error('外观模式无效');
    await this.area.set({ [APPEARANCE_KEY]: mode });
    return mode;
  }
}
