import * as Tooltip from '@radix-ui/react-tooltip';
import { Archive, ArchiveX } from 'lucide-react';

/**
 * 为实时窗口提供归档动作，悬停或键盘聚焦时显示说明；执行中禁用重复点击。
 * @param props.busy 是否正在等待该窗口的归档结果。
 * @param props.onArchive 执行归档；true 表示持久化成功后关闭。
 */
export function ArchiveActions({
  busy,
  onArchive,
}: {
  busy: boolean;
  onArchive(close: boolean): void;
}) {
  return (
    // 纯文字提示不接受鼠标交互，离开按钮即关闭，便于连续查看相邻图标。
    <Tooltip.Provider delayDuration={250} disableHoverableContent>
      <div className="archive-actions" data-native-keyboard>
        {[false, true].map((close) => {
          const label = close ? '归档并关闭窗口' : '归档窗口（保留打开）';
          // 悬浮提示保持简短，完整的按钮名称留给屏幕阅读器和自动化定位。
          const tooltip = close ? '归档并关闭' : '归档';
          const Icon = close ? ArchiveX : Archive;
          return (
            <Tooltip.Root key={String(close)}>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  className="archive-action icon-button"
                  disabled={busy}
                  aria-busy={busy}
                  aria-label={label}
                  onClick={() => onArchive(close)}
                >
                  <Icon aria-hidden="true" size={15} />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="action-tooltip" sideOffset={4}>
                  {busy ? '正在处理…' : tooltip}
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          );
        })}
      </div>
    </Tooltip.Provider>
  );
}
