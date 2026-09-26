import { describe, expect, it } from 'vitest';
import { adjacentWindowId } from '../../src/domain/window/adjacent-window';

/**
 * 验证窗口切换在边界处仍选择正确目标，防止键盘交互回归。
 *
 * 这些测试只覆盖纯粹的选择规则；Side Panel 焦点是否保留仍以 Edge 实测为准。
 */
describe('adjacentWindowId', () => {
  it('从末尾向前切换时返回首个窗口', () => {
    const windows = [
      { id: 11, focused: false },
      { id: 22, focused: false },
      { id: 33, focused: true },
    ];

    expect(adjacentWindowId(windows, 1)).toBe(11);
  });

  it('从首项反向切换时返回末尾窗口', () => {
    const windows = [
      { id: 11, focused: true },
      { id: 22, focused: false },
      { id: 33, focused: false },
    ];

    expect(adjacentWindowId(windows, -1)).toBe(33);
  });

  it('只有一个普通窗口时不发出切换目标', () => {
    expect(adjacentWindowId([{ id: 11, focused: true }], 1)).toBeUndefined();
  });
});
