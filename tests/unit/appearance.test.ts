import { describe, expect, it, vi } from 'vitest';
import { detectBrowser, isAppearanceMode } from '../../src/domain/appearance';
import { APPEARANCE_KEY, AppearanceStore } from '../../src/infrastructure/storage/appearance';
import type { StorageArea } from '../../src/infrastructure/storage/settings';

/** 模拟 storage.local 的结构化克隆行为，避免测试共享原对象引用。 */
function memoryArea(): StorageArea {
  const values: Record<string, unknown> = {};
  return {
    get: async (key) => structuredClone(key in values ? { [key]: values[key] } : {}),
    set: async (input) => {
      Object.assign(values, structuredClone(input));
    },
    remove: async (key) => {
      delete values[key];
    },
  };
}

describe('浏览器外观', () => {
  it('Client Hints 优先识别 Edge，其他 Chromium 使用 Chrome 外观', () => {
    expect(detectBrowser('Mozilla Chrome/153 Edg/153')).toBe('edge');
    expect(detectBrowser('Mozilla Chrome/153', [{ brand: 'Microsoft Edge' }])).toBe('edge');
    expect(detectBrowser('Mozilla Chrome/153', [{ brand: 'Chromium' }])).toBe('chrome');
    expect(detectBrowser('unknown')).toBe('chrome');
  });

  it('外观模式严格限定为自动、亮色或暗色', () => {
    expect(['auto', 'light', 'dark'].every(isAppearanceMode)).toBe(true);
    expect(isAppearanceMode('system')).toBe(false);
  });

  it('首次默认自动，写入后新实例仍可读取且不改写自动归档设置', async () => {
    const area = memoryArea();
    await area.set({ 'tabstash.settings.v1': { autoArchiveClosedWindows: true } });
    const store = new AppearanceStore(area);
    expect(await store.get()).toBe('auto');
    expect(await store.set('dark')).toBe('dark');
    expect(await new AppearanceStore(area).get()).toBe('dark');
    expect((await area.get('tabstash.settings.v1'))['tabstash.settings.v1']).toEqual({
      autoArchiveClosedWindows: true,
    });
  });

  it('读取损坏数据和写入失败时不覆盖原值', async () => {
    const area = memoryArea();
    const store = new AppearanceStore(area);
    await area.set({ [APPEARANCE_KEY]: 'broken' });
    await expect(store.get()).rejects.toThrow('格式无效');
    await area.set({ [APPEARANCE_KEY]: 'light' });
    vi.spyOn(area, 'set').mockRejectedValueOnce(new Error('写入失败'));
    await expect(store.set('dark')).rejects.toThrow('写入失败');
    expect(await store.get()).toBe('light');
  });
});
