import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { LANGUAGE_KEY, LanguageStore } from '../infrastructure/storage/language';
import { effectiveLocale, type LanguageMode, type Locale, translate } from './core';
import type { MessageKey } from './messages';

interface LanguageContextValue {
  mode: LanguageMode;
  locale: Locale;
  setMode(mode: LanguageMode): Promise<void>;
  t(key: MessageKey, params?: Record<string, string | number>): string;
  date(value: number | Date, withTime?: boolean): string;
  time(value: number | Date): string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

/** 为整个侧栏提供语言和格式化函数，并监听其他侧栏写入的语言选择。 */
export function LanguageProvider({
  initialMode,
  children,
}: {
  initialMode: LanguageMode;
  children: ReactNode;
}) {
  const [mode, setCurrentMode] = useState(initialMode);
  const browserLanguage = browser.i18n.getUILanguage();
  const locale = effectiveLocale(mode, browserLanguage);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    /** 重新读取确认后的存储值，避免多个侧栏同时更新时使用过时的事件值。 */
    const onChanged = (changes: Record<string, unknown>, area: string): void => {
      if (area !== 'local' || !(LANGUAGE_KEY in changes)) return;
      void new LanguageStore(browser.storage.local).get().then(setCurrentMode).catch(console.error);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({
      mode,
      locale,
      async setMode(next) {
        const saved = await new LanguageStore(browser.storage.local).set(next);
        setCurrentMode(saved);
      },
      t: (key, params) => translate(locale, key, params),
      date: (value, withTime = true) =>
        new Intl.DateTimeFormat(
          locale,
          withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
        ).format(value),
      time: (value) => new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(value),
    }),
    [mode, locale],
  );
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/** @returns 当前侧栏的语言、翻译及日期格式化函数。 */
export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('LanguageProvider is missing');
  return value;
}
