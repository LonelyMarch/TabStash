import { useEffect, useRef, useState } from 'react';
import { navigateTree } from '../domain/window/tree-navigation';

/** 树节点键盘操作的统一选择器，仅匹配当前实际渲染的节点按钮。 */
const NODE_SELECTOR = 'button[data-tree-node]';

/**
 * 为实时树接入方向键和操作键，并提供 F6 切换控件导航的能力。
 *
 * 焦点仅在当前侧栏文档内部移动，不尝试夺取网页或浏览器外壳的焦点。
 * 菜单、对话框和编辑区保留自身的键盘行为。
 *
 * @returns 树容器引用与控件导航模式，供界面和跨窗口 Tab 监听共用。
 */
export function useTreeKeyboard() {
  const treeRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLButtonElement>(null);
  const lastNodeKey = useRef<string | undefined>(undefined);
  const [controlsMode, setControlsMode] = useState(false);

  useEffect(() => {
    let focusedNode: HTMLElement | null = null;
    let ancestorKeys: string[] = [];
    /** 将键盘焦点移回最近节点；节点已删除时回到当前可见的第一项。 */
    const focusTree = (): void => {
      const nodes = Array.from(
        treeRef.current?.querySelectorAll<HTMLButtonElement>(NODE_SELECTOR) ?? [],
      );
      const target =
        [lastNodeKey.current, ...ancestorKeys]
          .map((key) => nodes.find((node) => node.dataset.treeNode === key))
          .find((node) => node !== undefined) ?? nodes[0];
      target?.focus();
    };

    /**
     * 处理侧栏内部导航，不改变浏览器原生标签组的展开状态。
     *
     * @param event 当前文档中的键盘事件。
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;

      if (event.key === 'F6' || (event.key === 'Escape' && controlsMode)) {
        event.preventDefault();
        if (event.repeat) return;
        if (controlsMode) focusTree();
        else controlsRef.current?.focus();
        setControlsMode(!controlsMode);
        return;
      }
      // 原生控件区域保留方向键，但 F6 仍应能退出控件导航回到实时树。
      if (target?.closest('[data-native-keyboard]')) return;
      if (controlsMode || target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }
      const tree = treeRef.current;
      if (!tree) return;
      if (
        !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(
          event.key,
        )
      )
        return;

      const buttons = Array.from(tree.querySelectorAll<HTMLButtonElement>(NODE_SELECTOR));
      const isNavigationKey =
        event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End';
      let button = target?.closest<HTMLButtonElement>(NODE_SELECTOR);
      if (button && !tree.contains(button)) button = null;

      // 折叠箭头与窗口标题共用同一个逻辑节点，但 Enter / Space 仍保留箭头的原生点击行为。
      if (!button && isNavigationKey) {
        const ownerKey = target?.closest<HTMLElement>('[data-tree-owner]')?.dataset.treeOwner;
        button = buttons.find((node) => node.dataset.treeNode === ownerKey);
      }
      if (!button) {
        // 侧栏空白、刷新按钮等位置也能用导航键进入树；不把 Enter / Space 误用到记忆节点上。
        if (!isNavigationKey || buttons.length === 0) return;
        event.preventDefault();
        const initial =
          event.key === 'Home'
            ? buttons[0]
            : event.key === 'End'
              ? buttons[buttons.length - 1]
              : (buttons.find((node) => node.dataset.treeNode === lastNodeKey.current) ??
                buttons[0]);
        initial?.focus();
        return;
      }

      // 阻止浏览器滚动及原生按钮二次触发，确保一次按键只执行一个动作。
      event.preventDefault();
      // 从独立折叠箭头进入时，把后续焦点固定到对应节点；折叠后也能继续导航。
      if (isNavigationKey && document.activeElement !== button) button.focus();
      // 从右向左阅读时，物理左右键对应的展开与返回方向也需要镜像。
      const navigationKey =
        document.documentElement.dir === 'rtl'
          ? event.key === 'ArrowLeft'
            ? 'ArrowRight'
            : event.key === 'ArrowRight'
              ? 'ArrowLeft'
              : event.key
          : event.key;
      const action = navigateTree(
        buttons.map((node) => ({
          key: node.dataset.treeNode ?? '',
          parentKey: node.dataset.treeParent ?? null,
          expanded: node.hasAttribute('aria-expanded')
            ? node.getAttribute('aria-expanded') === 'true'
            : undefined,
        })),
        button.dataset.treeNode ?? '',
        navigationKey,
      );
      if (action.kind === 'focus') {
        buttons.find((node) => node.dataset.treeNode === action.key)?.focus();
      } else if (action.kind === 'activate' && !event.repeat) {
        button.click();
      } else if (action.kind === 'toggle' && !event.repeat) {
        // 窗口的标题按钮用于激活，其独立的展开按钮负责切换 UI 状态。
        const disclosure =
          button.parentElement?.querySelector<HTMLButtonElement>('[data-tree-toggle]');
        (disclosure ?? button).click();
      }
    };

    /** 记住用户最后操作的节点，以便离开控件导航后回到树中。 */
    const onFocusIn = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement && event.target.matches(NODE_SELECTOR)) {
        lastNodeKey.current = event.target.dataset.treeNode;
        focusedNode = event.target;
        ancestorKeys = [];
        let parentKey = focusedNode.dataset.treeParent;
        const nodes = Array.from(
          treeRef.current?.querySelectorAll<HTMLElement>(NODE_SELECTOR) ?? [],
        );
        // 记录删除前的父链，以便刷新移除节点后回到仍存在的组或窗口。
        while (parentKey) {
          ancestorKeys.push(parentKey);
          parentKey = nodes.find((node) => node.dataset.treeNode === parentKey)?.dataset.treeParent;
        }
      } else {
        focusedNode = null;
      }
    };
    const observer = new MutationObserver(() => {
      if (focusedNode && !focusedNode.isConnected && document.activeElement === document.body) {
        focusedNode = null;
        // 仅修复本侧栏内部因删除节点造成的焦点丢失，不向失焦窗口请求焦点。
        if (document.hasFocus()) focusTree();
      }
    });
    if (treeRef.current) observer.observe(treeRef.current, { childList: true, subtree: true });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      observer.disconnect();
    };
  }, [controlsMode]);

  return { treeRef, controlsRef, controlsMode };
}
