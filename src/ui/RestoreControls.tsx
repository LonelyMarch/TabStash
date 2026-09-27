import * as Tooltip from '@radix-ui/react-tooltip';
import { Pin, PinOff, RotateCcw, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ArchivedWindow, RestoreCommand, RestoreJob } from '../domain/archive/models';
import { type Locale, translate, translateDiagnostic } from '../i18n/core';
import type { MessageKey } from '../i18n/messages';
import { useLanguage } from '../i18n/react';
import { sendMessage } from '../infrastructure/messaging/protocol';

/** @param result 持久恢复结果，区分标签创建数、结构失败与原归档是否移除。 */
export function restoreResultText(result: RestoreJob, locale: Locale): string {
  const warnings = [...result.errors, ...(result.progressWarnings ?? [])];
  const outcome =
    result.state === 'complete'
      ? result.archiveRemoved
        ? 'archiveRemoved'
        : 'archiveKept'
      : 'incompleteRestore';
  return translate(locale, 'restoredResult', {
    done: result.tabs.length,
    total: result.totalTabs,
    outcome: translate(locale, outcome),
    warnings: warnings.length
      ? ` ${warnings.map((warning) => translateDiagnostic(locale, warning)).join(locale === 'zh-CN' ? '；' : '; ')}`
      : '',
  });
}

/** 即时反馈保留原始恢复结果或词条键，语言切换时可重新渲染。 */
export type ArchiveNotice = { key: MessageKey } | { restore: RestoreJob } | null;

/**
 * 归档行右侧的四个图标操作共用忙碌状态，避免同一行同时执行多个操作。
 * @param props.archive 目标归档，恢复结果不确定时保留原请求 ID 用于安全重试。
 * @param props.onNotice 仅将失败或部分恢复反馈提升到列表，操作成功时清除旧提示。
 */
export function RestoreControls({
  archive,
  onNotice,
}: {
  archive: ArchivedWindow;
  onNotice(notice: ArchiveNotice): void;
}) {
  const { t } = useLanguage();
  const archiveId = archive.id;
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const pending = useRef<RestoreCommand | undefined>(undefined);

  /** @param removeAfterRestore 仅在完整成功后移除原归档。 */
  async function restore(removeAfterRestore: boolean): Promise<void> {
    if (active.current) return;
    if (pending.current && pending.current.removeAfterRestore !== removeAfterRestore) {
      onNotice({ key: 'restorePending' });
      return;
    }
    const command = pending.current ?? {
      requestId: crypto.randomUUID(),
      archiveId,
      removeAfterRestore,
    };
    pending.current = command;
    active.current = true;
    setBusy(true);
    // 按钮的忙碌状态已表示操作进行中；顶部只保留需要用户处理的结果。
    onNotice(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Restore timed out')), 60000);
      });
      const result = await Promise.race([sendMessage('restoreArchive', command), timeout]);
      pending.current = undefined;
      if (
        result.state !== 'complete' ||
        result.errors.length > 0 ||
        result.progressWarnings?.length
      ) {
        onNotice({ restore: result });
      }
    } catch (error: unknown) {
      console.error('Restore result unconfirmed', error);
      onNotice({ key: 'restoreUnconfirmed' });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      active.current = false;
      setBusy(false);
    }
  }

  /**
   * 执行置顶或直接删除，失败时保留原列表状态，由后台广播同步多面板。
   * @param deleting true 表示当前操作为删除归档。
   */
  async function manage(deleting: boolean): Promise<void> {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    onNotice(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Archive action timed out')), 8000);
      });
      await Promise.race([
        deleting
          ? sendMessage('deleteArchive', { archiveId })
          : sendMessage('setArchivePinned', { archiveId, pinned: !archive.pinned }),
        timeout,
      ]);
    } catch (error: unknown) {
      console.error('Archive action unconfirmed', error);
      onNotice({ key: 'operationUnconfirmed' });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      active.current = false;
      setBusy(false);
    }
  }

  // 与实时窗口的操作区使用相同图标按钮和提示；叉号置于回转箭头中心以区分普通恢复。
  const actions = [
    {
      key: 'restore',
      label: t('restore'),
      icon: <RotateCcw aria-hidden="true" size={15} />,
      run: () => void restore(false),
    },
    {
      key: 'restore-remove',
      label: t('restoreAndRemove'),
      icon: (
        <span aria-hidden="true" className="restore-remove-icon">
          <RotateCcw size={15} />
          <X size={8} strokeWidth={2.5} />
        </span>
      ),
      run: () => void restore(true),
    },
    {
      key: 'pin',
      label: archive.pinned ? t('unpin') : t('pin'),
      icon: archive.pinned ? (
        <PinOff aria-hidden="true" size={15} />
      ) : (
        <Pin aria-hidden="true" size={15} />
      ),
      run: () => void manage(false),
    },
    {
      key: 'delete',
      label: t('deleteArchive'),
      icon: <Trash2 aria-hidden="true" size={15} />,
      run: () => void manage(true),
    },
  ] as const;

  return (
    <div className="restore-controls" data-native-keyboard>
      {/* 操作提示不接收鼠标，避免离开图标后仍遮挡相邻操作。 */}
      <Tooltip.Provider delayDuration={250} disableHoverableContent>
        <div className="archive-actions restore-buttons">
          {actions.map((action) => {
            return (
              <Tooltip.Root key={action.key}>
                <Tooltip.Trigger asChild>
                  <button
                    aria-label={action.label}
                    aria-pressed={action.key === 'pin' ? archive.pinned : undefined}
                    className={`archive-action icon-button${action.key === 'delete' ? ' restore-delete-button' : ''}`}
                    disabled={busy}
                    onClick={action.run}
                    type="button"
                  >
                    {action.icon}
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="action-tooltip" sideOffset={4}>
                    {busy ? t('processing') : action.key === 'delete' ? t('delete') : action.label}
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            );
          })}
        </div>
      </Tooltip.Provider>
    </div>
  );
}
