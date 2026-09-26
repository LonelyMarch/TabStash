import { useCallback, useEffect, useRef, useState } from 'react';
import { onMessage, sendMessage } from '../infrastructure/messaging/protocol';
import { SettingSwitch } from './controls/SettingSwitch';

/** 展示自动归档设置及待重试状态；只有持久化成功才改变开关展示值。 */
export function AutoArchiveControl() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const generation = useRef(0);

  /** @param retry 是否重试已有的持久关闭记录；普通通知仅读取状态。 */
  const refresh = useCallback(async (retry = false) => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('自动归档状态读取超时')), 8000);
      });
      const [settings, result] = await Promise.race([
        Promise.all([
          sendMessage('getSettings'),
          retry ? sendMessage('retryAutoArchive') : sendMessage('getAutoArchiveStatus'),
        ]),
        timeout,
      ]);
      if (current !== generation.current) return;
      setEnabled(settings.autoArchiveClosedWindows);
      setError(result.error ?? '');
      setStatus(
        `${result.pendingCount ? `${result.pendingCount} 个关闭记录待重试。` : ''}${result.reviewCount ? `${result.reviewCount} 个关闭记录需核对（设置未知或缺少快照）。` : ''}`,
      );
    } catch (failure: unknown) {
      if (current === generation.current) setError(String(failure));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const removeSettings = onMessage('settingsInvalidated', () => {
      void refresh();
    });
    const removeStatus = onMessage('autoArchiveInvalidated', () => {
      void refresh();
    });
    void refresh();
    return () => {
      removeSettings();
      removeStatus();
      generation.current += 1;
    };
  }, [refresh]);

  /** @param value 用户请求的开关状态；写入失败保留原值并提供错误反馈。 */
  async function update(value: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('设置保存结果未确认，请重试读取状态')), 8000);
      });
      const saved = await Promise.race([
        sendMessage('updateSettings', { autoArchiveClosedWindows: value }),
        timeout,
      ]);
      setEnabled(saved.autoArchiveClosedWindows);
      setError('');
    } catch (failure: unknown) {
      setError(String(failure));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      setBusy(false);
    }
  }

  return (
    <div className="auto-archive-control" data-native-keyboard>
      <SettingSwitch
        checked={enabled ?? false}
        disabled={enabled === null || busy}
        label="自动归档关闭的窗口"
        onCheckedChange={(value) => {
          void update(value);
        }}
      />
      {error || status ? (
        <div role="status" className="help-text">
          {error} {status}
          <button
            type="button"
            className="refresh-button"
            onClick={() => {
              void refresh(true);
            }}
          >
            重试检查
          </button>
        </div>
      ) : null}
    </div>
  );
}
