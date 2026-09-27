import { isLanguageMode, type LanguageMode } from '../../i18n/core';
import type { StorageArea } from './settings';

/** 独立的语言设置键，避免改变现有自动归档设置对象。 */
export const LANGUAGE_KEY = 'tabstash.language.v1';

/** 在所有侧栏之间共用持久语言选择。 */
export class LanguageStore {
  /** @param area 浏览器 storage.local 或测试存储。 */
  constructor(private readonly area: Pick<StorageArea, 'get' | 'set'>) {}

  /** @returns 已保存模式；首次打开跟随浏览器语言。 */
  async get(): Promise<LanguageMode> {
    const value = (await this.area.get(LANGUAGE_KEY))[LANGUAGE_KEY];
    if (value === undefined) return 'auto';
    if (!isLanguageMode(value)) throw new Error('Invalid language setting');
    return value;
  }

  /** @param mode 用户选择。@returns 确认写入的模式。 */
  async set(mode: LanguageMode): Promise<LanguageMode> {
    if (!isLanguageMode(mode)) throw new Error('Invalid language mode');
    await this.area.set({ [LANGUAGE_KEY]: mode });
    return mode;
  }
}
