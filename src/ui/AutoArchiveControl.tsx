import { useCallback, useEffect, useRef, useState } from 'react';
import { type Diagnostic, diagnosticFromError, translateDiagnostic } from '../i18n/core';
import { useLanguage } from '../i18n/react';
import { onMessage, sendMessage } from '../infrastructure/messaging/protocol';
import { SettingSwitch } from './controls/SettingSwitch';

/** 展示自动归档设置及待重试状态；只有持久化成功才改变开关展示值。 */
export function AutoArchiveControl() {
  const { locale, t } = useLanguage();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Diagnostic | null>(null);
  const [status, setStatus] = useState<{ pending: number; review: number }>({
    pending: 0,
    review: 0,
  });
  const generation = useRef(0);

  /** @param retry 是否重试已有的持久关闭记录；普通通知仅读取状态。 */
  const refresh = useCallback(async (retry = false) => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Auto archive status timed out')), 8000);
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
      setError(result.error);
      setStatus({ pending: result.pendingCount, review: result.reviewCount });
    } catch (failure: unknown) {
      if (current === generation.current)
        setError(diagnosticFromError(failure, 'autoArchiveReadFailed'));
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
        timer = setTimeout(() => reject(new Error('Settings update timed out')), 8000);
      });
      const saved = await Promise.race([
        sendMessage('updateSettings', { autoArchiveClosedWindows: value }),
        timeout,
      ]);
      setEnabled(saved.autoArchiveClosedWindows);
      setError(null);
    } catch (failure: unknown) {
      setError(diagnosticFromError(failure, 'autoArchiveSaveFailed'));
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
        label={t('autoArchiveClosed')}
        onCheckedChange={(value) => {
          void update(value);
        }}
      />
      {error || status.pending || status.review ? (
        <div role="status" className="help-text">
          {error ? translateDiagnostic(locale, error) : null}{' '}
          {status.pending ? t('pendingClosed', { count: status.pending }) : null}
          {status.review ? t('reviewClosed', { count: status.review }) : null}
          <button
            type="button"
            className="refresh-button"
            onClick={() => {
              void refresh(true);
            }}
          >
            {t('retryCheck')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
