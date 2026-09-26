// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTreeKeyboard } from '../../src/ui/use-tree-keyboard';

let container: HTMLDivElement;
let root: Root;
const activate = vi.fn();

/** 创建与侧栏一致的独立折叠按钮、节点按钮及工具栏，验证事件到 DOM 焦点的完整路径。 */
function KeyboardFixture() {
  const { treeRef, controlsRef, controlsMode } = useTreeKeyboard();
  const [expanded, setExpanded] = useState(true);
  return createElement(
    'main',
    { 'data-controls-mode': controlsMode },
    createElement('button', { ref: controlsRef, type: 'button', id: 'settings' }, '设置'),
    createElement('button', { type: 'button', id: 'refresh', onClick: activate }, '刷新'),
    createElement('input', { id: 'editor', type: 'text' }),
    createElement(
      'div',
      { ref: treeRef },
      createElement(
        'div',
        {},
        createElement(
          'button',
          {
            id: 'disclosure',
            type: 'button',
            'data-tree-toggle': true,
            'data-tree-owner': 'w1',
            onClick: () => setExpanded(!expanded),
          },
          '展开',
        ),
        createElement(
          'button',
          {
            id: 'w1',
            type: 'button',
            'data-tree-node': 'w1',
            'aria-expanded': expanded,
            onClick: activate,
          },
          '窗口',
        ),
      ),
      expanded
        ? createElement(
            'button',
            {
              id: 't1',
              type: 'button',
              'data-tree-node': 't1',
              'data-tree-parent': 'w1',
              onClick: activate,
            },
            '标签',
          )
        : null,
      createElement('button', { type: 'button', id: 'w2', 'data-tree-node': 'w2' }, '窗口二'),
    ),
  );
}

/** 派发会冒泡的键盘事件，确保测试经过文档监听器而非只调用纯函数。 */
async function press(key: string): Promise<void> {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

/** 聚焦测试控件；元素缺失时立即失败，避免把错误的夹具当成通过。 */
function focus(id: string): void {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少测试控件：${id}`);
  element.focus();
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  activate.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(KeyboardFixture)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('侧栏真实 DOM 键盘入口', () => {
  it('侧栏空白获得焦点后，方向键即可进入树，无需点击节点', async () => {
    await press('ArrowDown');
    expect(document.activeElement?.id).toBe('w1');
    await press('ArrowDown');
    expect(document.activeElement?.id).toBe('t1');
    await press('ArrowUp');
    expect(document.activeElement?.id).toBe('w1');
    expect(activate).not.toHaveBeenCalled();
  });

  it('未聚焦节点时 Home 和 End 直接到首尾', async () => {
    await press('End');
    expect(document.activeElement?.id).toBe('w2');
    focus('refresh');
    await press('Home');
    expect(document.activeElement?.id).toBe('w1');
  });

  it('窗口折叠按钮上的方向键按所属窗口导航', async () => {
    focus('disclosure');
    await press('ArrowRight');
    expect(document.activeElement?.id).toBe('t1');
    await press('ArrowLeft');
    expect(document.activeElement?.id).toBe('w1');
    await press('ArrowLeft');
    expect(document.getElementById('t1')).toBeNull();
  });

  it('节点上的 Home 和 End 保持可用，Enter 只激活一次', async () => {
    focus('t1');
    await press('Enter');
    expect(activate).toHaveBeenCalledTimes(1);
    await press('End');
    expect(document.activeElement?.id).toBe('w2');
    await press('Home');
    expect(document.activeElement?.id).toBe('w1');
  });

  it('编辑区和 F6 控件模式不被树导航抢占，Esc 返回树', async () => {
    focus('editor');
    await press('Home');
    expect(document.activeElement?.id).toBe('editor');
    await press('F6');
    expect(document.activeElement?.id).toBe('settings');
    focus('refresh');
    await press('End');
    expect(document.activeElement?.id).toBe('refresh');
    await press('Escape');
    expect(document.activeElement?.id).toBe('w1');
  });
});
