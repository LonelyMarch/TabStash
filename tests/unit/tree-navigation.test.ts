import { describe, expect, it } from 'vitest';
import { type NavigationNode, navigateTree } from '../../src/domain/window/tree-navigation';

/** 可见树包含一个展开窗口、一个展开分组、组内标签及折叠窗口。 */
const nodes: NavigationNode[] = [
  { key: 'w1', parentKey: null, expanded: true },
  { key: 'g1', parentKey: 'w1', expanded: true },
  { key: 't1', parentKey: 'g1' },
  { key: 't2', parentKey: 'w1' },
  { key: 'w2', parentKey: null, expanded: false },
];

describe('实时树键盘导航', () => {
  it('上下移动只访问可见节点，在首尾保持焦点', () => {
    expect(navigateTree(nodes, 'g1', 'ArrowDown')).toEqual({ kind: 'focus', key: 't1' });
    expect(navigateTree(nodes, 't2', 'ArrowUp')).toEqual({ kind: 'focus', key: 't1' });
    expect(navigateTree(nodes, 'w1', 'ArrowUp')).toEqual({ kind: 'focus', key: 'w1' });
    expect(navigateTree(nodes, 'w2', 'ArrowDown')).toEqual({ kind: 'focus', key: 'w2' });
  });

  it('左右键区分展开、折叠、进入子节点及返回父节点', () => {
    expect(navigateTree(nodes, 'w2', 'ArrowRight')).toEqual({ kind: 'toggle', key: 'w2' });
    expect(navigateTree(nodes, 'g1', 'ArrowLeft')).toEqual({ kind: 'toggle', key: 'g1' });
    expect(navigateTree(nodes, 'g1', 'ArrowRight')).toEqual({ kind: 'focus', key: 't1' });
    expect(navigateTree(nodes, 't1', 'ArrowLeft')).toEqual({ kind: 'focus', key: 'g1' });
    expect(navigateTree(nodes, 't1', 'ArrowRight')).toEqual({ kind: 'none' });
    expect(navigateTree(nodes, 'w2', 'ArrowLeft')).toEqual({ kind: 'none' });
  });

  it('折叠分组左键返回窗口，右键展开而不会进入兄弟标签', () => {
    const collapsed: NavigationNode[] = [
      { key: 'w1', parentKey: null, expanded: true },
      { key: 'g1', parentKey: 'w1', expanded: false },
      { key: 't2', parentKey: 'w1' },
    ];
    expect(navigateTree(collapsed, 'g1', 'ArrowLeft')).toEqual({ kind: 'focus', key: 'w1' });
    expect(navigateTree(collapsed, 'g1', 'ArrowRight')).toEqual({ kind: 'toggle', key: 'g1' });
  });

  it('Space 只折叠容器，Enter 激活节点，Home 和 End 跳转首尾', () => {
    expect(navigateTree(nodes, 'g1', ' ')).toEqual({ kind: 'toggle', key: 'g1' });
    expect(navigateTree(nodes, 't1', ' ')).toEqual({ kind: 'none' });
    expect(navigateTree(nodes, 't1', 'Enter')).toEqual({ kind: 'activate', key: 't1' });
    expect(navigateTree(nodes, 't1', 'Home')).toEqual({ kind: 'focus', key: 'w1' });
    expect(navigateTree(nodes, 't1', 'End')).toEqual({ kind: 'focus', key: 'w2' });
  });

  it('空树、已删除节点及其他按键不触发操作', () => {
    expect(navigateTree([], 'w1', 'ArrowDown')).toEqual({ kind: 'none' });
    expect(navigateTree(nodes, 'deleted', 'Enter')).toEqual({ kind: 'none' });
    expect(navigateTree(nodes, 't1', 'Tab')).toEqual({ kind: 'none' });
  });
});
