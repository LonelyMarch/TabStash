/** 选择相邻窗口时只依赖运行时窗口 ID 与当前焦点标记。 */
export interface FocusableWindow {
  id: number;
  focused: boolean;
}

/**
 * 在当前普通窗口列表中选择上一个或下一个窗口。
 *
 * 列表顺序由调用方确定。没有焦点标记时从首项开始，只有一个窗口时不发起
 * 无意义的切换请求。窗口 ID 仅在当前浏览器会话中使用，不写入归档。
 *
 * @param windows 已按界面展示顺序排列的普通窗口。
 * @param direction 1 表示下一个，-1 表示上一个。
 * @returns 相邻窗口的运行时 ID；无法切换时返回 undefined。
 */
export function adjacentWindowId(
  windows: readonly FocusableWindow[],
  direction: 1 | -1,
): number | undefined {
  if (windows.length < 2) {
    return undefined;
  }

  const focusedIndex = windows.findIndex((window) => window.focused);
  const currentIndex = focusedIndex >= 0 ? focusedIndex : 0;
  const nextIndex = (currentIndex + direction + windows.length) % windows.length;
  return windows[nextIndex]?.id;
}
