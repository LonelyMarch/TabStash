import { browser } from 'wxt/browser';
import type { RestoreBrowser } from '../../application/archive/restore';
import type { Diagnostic } from '../../i18n/core';

/** Edge/Chromium 恢复 API 的薄适配器，不读取网页内容或使用内容脚本。 */
export const restoreBrowser: RestoreBrowser = {
  /** 创建普通窗口并记录唯一默认标签，只允许后续删除这个默认标签。 */
  async createWindow() {
    const created = await browser.windows.create({
      type: 'normal',
      url: 'about:blank',
      focused: false,
    });
    if (created?.id === undefined) throw new Error('创建窗口后未返回窗口 ID');
    const tabs = created.tabs ?? (await browser.tabs.query({ windowId: created.id }));
    const placeholderTabId = tabs[0]?.id;
    if (placeholderTabId === undefined)
      throw new Error(`窗口 ${created.id} 已创建，但未获得默认标签 ID`);
    return { windowId: created.id, placeholderTabId };
  },
  /** @param windowId 新窗口；标签逐个创建以保留顺序，并直接设置 pinned。 */
  async createTab(windowId, tab, index) {
    if (!tab.url) throw new Error('缺少标签 URL');
    const created = await browser.tabs.create({
      windowId,
      url: tab.url,
      index,
      pinned: tab.pinned,
      active: false,
    });
    if (created.id === undefined) throw new Error('浏览器未返回标签 ID');
    return created.id;
  },
  /** 删除前复查默认标签，避免用户在恢复过程中导航后被误删。 */
  async removePlaceholder(windowId, tabId) {
    const current = await browser.tabs.get(tabId);
    if (
      current.windowId !== windowId ||
      (current.pendingUrl ?? current.url) !== 'about:blank' ||
      current.pinned
    )
      throw new Error('默认标签已被用户修改，已保留该标签');
    await browser.tabs.remove(tabId);
  },
  /** 创建组并还原标题与颜色；折叠状态在活动标签恢复之后设置。 */
  async createGroup(windowId, ids, group) {
    const first = ids[0];
    if (first === undefined) throw new Error('没有可分组标签');
    const groupId = await browser.tabs.group({
      tabIds: [first, ...ids.slice(1)],
      createProperties: { windowId },
    });
    await browser.tabGroups.update(groupId, { title: group.title ?? '', color: group.color });
    return groupId;
  },
  /** @param groupId 新建标签组，恢复其原生折叠状态。 */
  async collapseGroup(groupId, collapsed) {
    await browser.tabGroups.update(groupId, { collapsed });
  },
  /** @param tabId 将原活动标签设为新窗口活动标签。 */
  async activateTab(tabId) {
    await browser.tabs.update(tabId, { active: true });
  },
  /** 先在普通状态应用尺寸，最后恢复最大化等状态，避免冲突参数导致 API 拒绝。 */
  async applyWindow(windowId, snapshot) {
    await browser.windows.update(windowId, { state: 'normal' });
    const bounds = Object.fromEntries(
      ['left', 'top', 'width', 'height'].flatMap((key) => {
        const value = snapshot[key as 'left' | 'top' | 'width' | 'height'];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    if (Object.keys(bounds).length) await browser.windows.update(windowId, bounds);
    await browser.windows.update(windowId, {
      state: snapshot.state ?? 'normal',
      ...(snapshot.state === 'minimized' ? {} : { focused: true }),
    });
  },
  /**
   * 核对实际标签、顺序、组、活动标签和窗口状态。
   * 网络加载和重定向不作为创建成功条件，不宣称恢复登录、表单或页面滚动状态。
   */
  async verify(job, snapshot) {
    if (job.windowId === undefined) return [{ key: 'diagnosticNoVerifyWindow' }];
    const window = await browser.windows.get(job.windowId, { populate: true });
    const tabs = [...(window.tabs ?? [])].sort((a, b) => a.index - b.index);
    const groups = await browser.tabGroups.query({ windowId: job.windowId });
    const errors: Diagnostic[] = [];
    const expected = [...snapshot.tabs].sort((a, b) => a.index - b.index);
    if (tabs.length !== expected.length) errors.push({ key: 'diagnosticTabCountMismatch' });
    for (const [index, source] of expected.entries()) {
      const mapping = job.tabs.find((entry) => entry.key === source.key);
      const actual = tabs.find((tab) => tab.id === mapping?.id);
      if (!actual) {
        errors.push({
          key: 'diagnosticTabMissing',
          params: { title: source.title || source.url || '' },
        });
        continue;
      }
      if (actual.id !== tabs[index]?.id || actual.pinned !== source.pinned)
        errors.push({ key: 'diagnosticTabOrder', params: { title: source.title || '' } });
      const expectedGroup = job.groups.find((entry) => entry.key === source.groupKey)?.id ?? -1;
      if (actual.groupId !== expectedGroup)
        errors.push({ key: 'diagnosticTabGroup', params: { title: source.title || '' } });
      if (source.key === snapshot.activeTabKey && !actual.active)
        errors.push({ key: 'diagnosticActiveTab' });
      if (actual.url?.startsWith('chrome-error:') || actual.url?.startsWith('edge-error:'))
        errors.push({ key: 'diagnosticTabLoad', params: { title: source.title || '' } });
    }
    for (const source of snapshot.groups) {
      const mapping = job.groups.find((entry) => entry.key === source.key);
      const actual = groups.find((group) => group.id === mapping?.id);
      if (
        !actual ||
        (actual.title ?? '') !== (source.title ?? '') ||
        actual.color !== source.color ||
        actual.collapsed !== source.collapsed
      )
        errors.push({ key: 'diagnosticGroupAttributes', params: { title: source.title || '' } });
    }
    if (snapshot.state && window.state !== snapshot.state)
      errors.push({ key: 'diagnosticWindowState' });
    return errors;
  },
  /**
   * 等待新标签内容脚本加载并应用网页进度；页面受限或导航变化时只返回警告。
   * @param tabId 新创建的浏览器标签。
   * @param progress 归档中保存的页面滚动和媒体时间。
   */
  async restoreProgress(tabId, progress) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const tab = await browser.tabs.get(tabId);
      if ((tab.pendingUrl ?? tab.url) !== progress.url) return [{ key: 'diagnosticUrlChanged' }];
      try {
        const result = (await browser.tabs.sendMessage(tabId, {
          type: 'tabstash:restore-progress',
          progress,
        })) as { warnings?: Diagnostic[] };
        return Array.isArray(result?.warnings)
          ? result.warnings
          : [{ key: 'diagnosticProgressResponse' }];
      } catch {
        // 内容脚本可能仍在等待 document_idle，短暂重试不影响标签结构恢复。
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    }
    return [{ key: 'diagnosticProgressTimeout' }];
  },
};
