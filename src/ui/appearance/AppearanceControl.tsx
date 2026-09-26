import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type AppearanceMode, isAppearanceMode } from '../../domain/appearance';
import { onMessage, sendMessage } from '../../infrastructure/messaging/protocol';

const labels: Record<AppearanceMode, string> = {
  auto: '自动',
  light: '亮色',
  dark: '暗色',
};

/**
 * 在所有侧栏之间同步外观模式，并提供可用键盘操作的设置菜单。
 */
export function AppearanceControl() {
  const [mode, setMode] = useState<AppearanceMode>(() => {
    const initial = document.documentElement.dataset.theme;
    return isAppearanceMode(initial) ? initial : 'auto';
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const writing = useRef(false);

  /** 读取已确认的模式；后台通知只触发重新读取，不猜测其他侧栏的选择。 */
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const saved = await sendMessage('getAppearance');
      if (current !== generation.current) return;
      setMode(saved);
      document.documentElement.dataset.theme = saved;
      setError('');
    } catch (failure: unknown) {
      if (current === generation.current) setError(`外观读取失败：${String(failure)}`);
    }
  }, []);

  useEffect(() => {
    const remove = onMessage('appearanceInvalidated', () => {
      void refresh();
    });
    void refresh();
    return () => {
      remove();
      generation.current += 1;
    };
  }, [refresh]);

  /** @param nextMode 用户选择的模式；持久化失败时保留原有外观。 */
  async function update(nextMode: AppearanceMode): Promise<void> {
    if (writing.current || nextMode === mode) return;
    writing.current = true;
    setBusy(true);
    try {
      const saved = await sendMessage('setAppearance', { mode: nextMode });
      setMode(saved);
      document.documentElement.dataset.theme = saved;
      setError('');
    } catch (failure: unknown) {
      setError(`外观保存失败：${String(failure)}`);
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  const CurrentIcon = mode === 'dark' ? Moon : mode === 'light' ? Sun : Monitor;
  return (
    <div className="appearance-control" data-native-keyboard>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            aria-label={`外观：${labels[mode]}`}
            className="appearance-trigger icon-button"
            disabled={busy}
            title={`外观：${labels[mode]}`}
            type="button"
          >
            <CurrentIcon aria-hidden="true" size={18} />
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
            <DropdownMenu.Label className="appearance-menu-label">外观</DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              onValueChange={(value) => {
                if (isAppearanceMode(value)) void update(value);
              }}
              value={mode}
            >
              {(['auto', 'light', 'dark'] as const).map((option) => {
                const Icon = option === 'auto' ? Monitor : option === 'light' ? Sun : Moon;
                return (
                  <DropdownMenu.RadioItem
                    className="appearance-menu-item"
                    disabled={busy}
                    key={option}
                    value={option}
                  >
                    <Icon aria-hidden="true" size={16} />
                    <span>{labels[option]}</span>
                    <DropdownMenu.ItemIndicator className="appearance-menu-check">
                      <Check aria-hidden="true" size={16} />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                );
              })}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {error ? <output className="appearance-error">{error}</output> : null}
    </div>
  );
}
