// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchivedWindow } from '../../src/domain/archive/models';

const messages = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock('../../src/infrastructure/messaging/protocol', () => messages);

import { RestoreControls } from '../../src/ui/RestoreControls';

let container: HTMLDivElement;
let root: Root;
const notice = vi.fn();
const archive: ArchivedWindow = {
  id: 'a',
  archivedAt: 1,
  pinned: false,
  source: 'manual',
  snapshotHash: 'h',
  snapshot: {
    tabs: [{ key: 't', title: '待管理窗口', url: 'https://example.com', index: 0, pinned: false }],
    groups: [],
  },
};

/** 通过可访问名称选择归档图标按钮，缺失即失败。 */
async function clickButton(name: string): Promise<void> {
  const target = [...document.querySelectorAll<HTMLElement>('button')].find(
    (item) => (item.getAttribute('aria-label') ?? item.textContent) === name,
  );
  if (!target) throw new Error(`找不到控件：${name}`);
  await act(async () => target.click());
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  messages.sendMessage.mockReset().mockResolvedValue(undefined);
  notice.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(RestoreControls, { archive, onNotice: notice })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('归档操作按钮与直接删除', () => {
  it('四项操作直接显示，置顶只发送目标状态', async () => {
    expect([...container.querySelectorAll('.restore-buttons button')]).toHaveLength(4);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(
      [...container.querySelectorAll('.restore-buttons button')].map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['恢复', '恢复并移除', '置顶', '删除归档']);
    await clickButton('置顶');
    expect(messages.sendMessage).toHaveBeenCalledExactlyOnceWith('setArchivePinned', {
      archiveId: 'a',
      pinned: true,
    });
    expect(notice).toHaveBeenCalledExactlyOnceWith('');
  });

  it('点击删除直接提交，数据库失败时保留归档并展示错误', async () => {
    messages.sendMessage.mockRejectedValue(new Error('数据库不可用'));
    await clickButton('删除归档');
    expect(messages.sendMessage).toHaveBeenCalledExactlyOnceWith('deleteArchive', {
      archiveId: 'a',
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(notice).toHaveBeenLastCalledWith('操作未完成确认：Error: 数据库不可用');
  });

  it('删除成功不显示结果横幅', async () => {
    messages.sendMessage.mockResolvedValue(true);
    await clickButton('删除归档');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(notice).toHaveBeenCalledExactlyOnceWith('');
  });
});
