import { describe, expect, it, vi } from 'vitest';
import {
  type Diagnostic,
  effectiveLocale,
  isLanguageMode,
  locales,
  resolveLocale,
  translate,
  translateDiagnostic,
} from '../../src/i18n/core';
import { ar } from '../../src/i18n/locales/ar';
import { es } from '../../src/i18n/locales/es';
import { fr } from '../../src/i18n/locales/fr';
import { ru } from '../../src/i18n/locales/ru';
import { en, zhCN } from '../../src/i18n/messages';
import { LANGUAGE_KEY, LanguageStore } from '../../src/infrastructure/storage/language';
import type { StorageArea } from '../../src/infrastructure/storage/settings';

/** 模拟 storage.local 的结构化克隆，确保新实例只读取已持久化的数据。 */
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

describe('侧栏语言', () => {
  it('自动模式识别六种官方语言及地区变体，手动选择优先', () => {
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    expect(resolveLocale('zh-Hans')).toBe('zh-CN');
    expect(resolveLocale('zh-SG')).toBe('zh-CN');
    expect(resolveLocale('zh-TW')).toBe('zh-CN');
    expect(resolveLocale('zh-HK')).toBe('zh-CN');
    expect(resolveLocale('en-US')).toBe('en');
    expect(resolveLocale('ar-SA')).toBe('ar');
    expect(resolveLocale('fr-FR')).toBe('fr');
    expect(resolveLocale('ru-RU')).toBe('ru');
    expect(resolveLocale('es-MX')).toBe('es');
    expect(resolveLocale('de-DE')).toBe('en');
    expect(effectiveLocale('en', 'zh-CN')).toBe('en');
    expect(effectiveLocale('ar', 'en-US')).toBe('ar');
    expect(effectiveLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(['auto', ...locales].every(isLanguageMode)).toBe(true);
    expect(isLanguageMode('de')).toBe(false);
  });

  it('语言设置跨实例持久化；写入失败保留已确认的值', async () => {
    const area = memoryArea();
    const store = new LanguageStore(area);
    expect(await store.get()).toBe('auto');
    await store.set('en');
    expect(await new LanguageStore(area).get()).toBe('en');
    vi.spyOn(area, 'set').mockRejectedValueOnce(new Error('quota'));
    await expect(store.set('zh-CN')).rejects.toThrow('quota');
    expect(await store.get()).toBe('en');
    await area.set({ [LANGUAGE_KEY]: 'unknown' });
    await expect(store.get()).rejects.toThrow('Invalid language setting');
  });

  it('六个词表键与参数一致，未填参数不会静默消失', () => {
    const dictionaries = { en, ar, fr, ru, es };
    for (const dictionary of Object.values(dictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(Object.keys(zhCN).sort());
    }
    for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
      const parameters = (value: string) =>
        [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      for (const dictionary of Object.values(dictionaries)) {
        expect(parameters(dictionary[key])).toEqual(parameters(zhCN[key]));
      }
    }
    expect(translate('en', 'window', { index: 2 })).toBe('Window 2');
    expect(translate('fr', 'window', { index: 2 })).toBe('Fenêtre 2');
    expect(translate('ar', 'window', { index: 2 })).toContain('2');
    expect(translate('zh-CN', 'window')).toContain('{index}');
  });

  it('同一持久诊断不修改数据即可按当前语言重新渲染', () => {
    const saved: Diagnostic = { key: 'diagnosticTabMissing', params: { title: 'Example' } };
    expect(translateDiagnostic('zh-CN', saved)).toBe('标签“Example”在核对时不存在。');
    expect(translateDiagnostic('en', saved)).toBe('Tab “Example” is missing during verification.');
  });
});
