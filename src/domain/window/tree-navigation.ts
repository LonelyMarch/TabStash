/** 当前可见节点的键盘导航信息；不包含浏览器操作或 DOM 引用。 */
export interface NavigationNode {
  key: string;
  parentKey: string | null;
  expanded?: boolean | undefined;
}

/** 键盘动作由 UI 执行，纯逻辑只决定焦点目标或展开动作。 */
export type NavigationAction =
  | { kind: 'focus'; key: string }
  | { kind: 'toggle'; key: string }
  | { kind: 'activate'; key: string }
  | { kind: 'none' };

/**
 * 根据可见节点顺序解析键盘操作，折叠子节点不会进入导航列表。
 *
 * @param nodes 按界面显示顺序排列的可见节点。
 * @param currentKey 当前拥有键盘焦点的节点标识。
 * @param key 用户按下的原始键名。
 * @returns UI 应执行的动作；边界位置保持原节点，不循环跳转。
 */
export function navigateTree(
  nodes: readonly NavigationNode[],
  currentKey: string,
  key: string,
): NavigationAction {
  const index = nodes.findIndex((node) => node.key === currentKey);
  const current = nodes[index];
  if (current === undefined) return { kind: 'none' };

  let target: NavigationNode | undefined;
  switch (key) {
    case 'ArrowUp':
      target = nodes[Math.max(0, index - 1)];
      break;
    case 'ArrowDown':
      target = nodes[Math.min(nodes.length - 1, index + 1)];
      break;
    case 'Home':
      target = nodes[0];
      break;
    case 'End':
      target = nodes[nodes.length - 1];
      break;
    case 'ArrowLeft':
      if (current.expanded === true) return { kind: 'toggle', key: current.key };
      target = nodes.find((node) => node.key === current.parentKey);
      break;
    case 'ArrowRight':
      if (current.expanded === false) return { kind: 'toggle', key: current.key };
      // 只进入自己的直接子节点，叶子节点不能误跳到下一个兄弟节点。
      if (nodes[index + 1]?.parentKey === current.key) target = nodes[index + 1];
      break;
    case ' ':
      return current.expanded === undefined
        ? { kind: 'none' }
        : { kind: 'toggle', key: current.key };
    case 'Enter':
      return { kind: 'activate', key: current.key };
  }
  return target === undefined ? { kind: 'none' } : { kind: 'focus', key: target.key };
}
