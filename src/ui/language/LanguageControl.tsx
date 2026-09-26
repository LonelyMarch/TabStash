import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, Languages } from 'lucide-react';
import { useState } from 'react';
import { isLanguageMode, type LanguageMode } from '../../i18n/core';
import { useLanguage } from '../../i18n/react';

/** 语言菜单同时支持浏览器自动语言和显式覆盖，并在保存成功后更新界面。 */
export function LanguageControl() {
  const { mode, setMode, t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const labels: Record<LanguageMode, string> = {
    auto: t('autoLanguage'),
    'zh-CN': t('chinese'),
    en: t('english'),
  };

  /** @param nextMode 用户选择的语言；写入失败时继续使用已确认的选择。 */
  async function update(nextMode: LanguageMode): Promise<void> {
    if (busy || nextMode === mode) return;
    setBusy(true);
    try {
      await setMode(nextMode);
      setError(false);
    } catch (failure: unknown) {
      console.error('Could not save language setting', failure);
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="appearance-control" data-native-keyboard>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            aria-label={t('languageCurrent', { mode: labels[mode] })}
            className="appearance-trigger icon-button"
            disabled={busy}
            title={t('languageCurrent', { mode: labels[mode] })}
            type="button"
          >
            <Languages aria-hidden="true" size={18} />
            <span>{labels[mode]}</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="appearance-menu"
            data-native-keyboard
            sideOffset={6}
          >
            <DropdownMenu.Label className="appearance-menu-label">
              {t('language')}
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={mode}
              onValueChange={(value) => {
                if (isLanguageMode(value)) void update(value);
              }}
            >
              {(['auto', 'zh-CN', 'en'] as const).map((option) => (
                <DropdownMenu.RadioItem
                  className="appearance-menu-item"
                  disabled={busy}
                  key={option}
                  value={option}
                >
                  <Languages aria-hidden="true" size={16} />
                  <span>{labels[option]}</span>
                  <DropdownMenu.ItemIndicator className="appearance-menu-check">
                    <Check aria-hidden="true" size={16} />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {error ? <output className="appearance-error">{t('languageSaveFailed')}</output> : null}
    </div>
  );
}
