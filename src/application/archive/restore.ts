import type {
  GroupSnapshot,
  PageProgress,
  RestoreCommand,
  RestoreJob,
  TabSnapshot,
  WindowSnapshot,
} from '../../domain/archive/models';
import { AppError, type Diagnostic, diagnosticFromError } from '../../i18n/core';
import type { RestoreRepository } from '../../infrastructure/db/restore-repository';

/** 恢复的浏览器能力，以薄适配器隔离 API，测试可对任意步骤注入失败。 */
export interface RestoreBrowser {
  createWindow(): Promise<{ windowId: number; placeholderTabId: number }>;
  createTab(windowId: number, tab: TabSnapshot, index: number): Promise<number>;
  removePlaceholder(windowId: number, tabId: number): Promise<void>;
  createGroup(windowId: number, ids: number[], group: GroupSnapshot): Promise<number>;
  collapseGroup(groupId: number, collapsed: boolean): Promise<void>;
  activateTab(tabId: number): Promise<void>;
  applyWindow(windowId: number, snapshot: WindowSnapshot): Promise<void>;
  verify(job: RestoreJob, snapshot: WindowSnapshot): Promise<Diagnostic[]>;
  restoreProgress(tabId: number, progress: PageProgress): Promise<Diagnostic[]>;
}

/** 恢复用例依赖；每次浏览器写入后立即记录进度，存储失败不继续操作。 */
interface Dependencies {
  repository: RestoreRepository;
  browser: RestoreBrowser;
  sessionId(): Promise<string>;
  changed(): void;
}

/**
 * 逐标签恢复并保留所有部分失败；完整核对后才允许事务移除原归档。
 * 同请求跨重启返回持久回执，不在未知状态下重放浏览器操作。
 */
export class RestoreService {
  private initialization: Promise<number> | undefined;
  private readonly active = new Map<
    string,
    { command: RestoreCommand; task: Promise<RestoreJob> }
  >();

  /** @param dependencies 持久化及浏览器适配器。 */
  constructor(private readonly dependencies: Dependencies) {}

  /** 启动核对只执行一次；初始化失败允许下次调用重试。 */
  initialize(): Promise<number> {
    if (!this.initialization)
      this.initialization = this.dependencies.repository
        .interruptUnfinished()
        .catch((error: unknown) => {
          this.initialization = undefined;
          throw error;
        });
    return this.initialization;
  }

  /** @param command 当前用户的恢复请求；只允许同一归档同时有一个活动恢复。 */
  execute(command: RestoreCommand): Promise<RestoreJob> {
    if (
      !command ||
      typeof command.requestId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(command.requestId) ||
      typeof command.archiveId !== 'string' ||
      !command.archiveId ||
      typeof command.removeAfterRestore !== 'boolean'
    ) {
      return Promise.reject(new Error('恢复请求参数无效'));
    }
    const current = this.active.get(command.archiveId);
    if (current)
      return current.command.requestId === command.requestId &&
        current.command.removeAfterRestore === command.removeAfterRestore
        ? current.task
        : Promise.reject(new Error('此归档正在恢复，请等待完成'));
    const task = this.run(command).finally(() => {
      this.active.delete(command.archiveId);
    });
    this.active.set(command.archiveId, { command, task });
    return task;
  }

  /**
   * 恢复窗口、标签和组；浏览器步骤错误只记入结果，进度写入错误停止恢复。
   * @param command 已校验并占用操作位的请求。
   */
  private async run(command: RestoreCommand): Promise<RestoreJob> {
    await this.initialize();
    const { repository, browser, changed } = this.dependencies;
    const existing = await repository.get(command.requestId);
    if (existing) {
      if (
        existing.archiveId !== command.archiveId ||
        existing.removeAfterRestore !== command.removeAfterRestore
      )
        throw new Error('恢复请求 ID 已被其他操作使用');
      return existing;
    }
    const { archive, job } = await repository.begin(command, await this.dependencies.sessionId());
    const snapshot = archive.snapshot;
    try {
      if (
        !snapshot.tabs.length ||
        new Set(snapshot.tabs.map((tab) => tab.key)).size !== snapshot.tabs.length ||
        new Set(snapshot.groups.map((group) => group.key)).size !== snapshot.groups.length
      )
        throw new Error('归档为空或快照标识重复');
      const created = await browser.createWindow();
      job.windowId = created.windowId;
      job.placeholderTabId = created.placeholderTabId;
      await repository.save(job);
      const ordered = [...snapshot.tabs].sort((a, b) => a.index - b.index);
      for (const tab of ordered) {
        try {
          if (!tab.url) throw new AppError({ key: 'diagnosticMissingSavedUrl' });
          const protocol = new URL(tab.url).protocol;
          if (!['http:', 'https:', 'file:', 'about:', 'edge:', 'chrome:'].includes(protocol))
            throw new AppError({ key: 'diagnosticUnsupportedUrl', params: { protocol } });
          const id = await browser.createTab(created.windowId, tab, job.tabs.length);
          job.tabs.push({ key: tab.key, id });
        } catch (error: unknown) {
          const diagnostic = diagnosticFromError(error, 'diagnosticRestoreTab');
          job.errors.push(
            diagnostic.key === 'diagnosticRestoreTab'
              ? { ...diagnostic, params: { title: tab.title || tab.url || '' } }
              : diagnostic,
          );
        }
        await repository.save(job);
      }
      // 全部标签失败时保留默认空白页，不关闭新窗口或丢失可见的错误现场。
      if (job.tabs.length) {
        try {
          await browser.removePlaceholder(created.windowId, created.placeholderTabId);
        } catch (error: unknown) {
          console.error('Could not remove placeholder tab', error);
          job.errors.push({ key: 'diagnosticPlaceholder' });
        }
      }
      for (const group of snapshot.groups) {
        const members = ordered.filter((tab) => tab.groupKey === group.key);
        const ids = members.flatMap((tab) =>
          job.tabs.filter((entry) => entry.key === tab.key).map((entry) => entry.id),
        );
        try {
          if (!members.length || !ids.length) throw new Error('没有可恢复的组成员');
          if (ids.length !== members.length)
            job.errors.push({
              key: 'diagnosticGroupPartial',
              params: { title: group.title || '' },
            });
          if (members.some((tab) => tab.pinned)) throw new Error('浏览器不支持在组内放置固定标签');
          job.groups.push({
            key: group.key,
            id: await browser.createGroup(created.windowId, ids, group),
          });
        } catch (error: unknown) {
          console.error('Could not restore tab group', error);
          job.errors.push({ key: 'diagnosticGroupRestore', params: { title: group.title || '' } });
        }
        await repository.save(job);
      }
      if (
        ordered.some(
          (tab) => tab.groupKey && !snapshot.groups.some((group) => group.key === tab.groupKey),
        )
      )
        job.errors.push({ key: 'diagnosticGroupReference' });
      if (snapshot.activeTabKey) {
        const active = job.tabs.find((tab) => tab.key === snapshot.activeTabKey);
        if (!active) job.errors.push({ key: 'diagnosticOriginalActive' });
        else
          try {
            await browser.activateTab(active.id);
          } catch (error: unknown) {
            console.error('Could not activate restored tab', error);
            job.errors.push({ key: 'diagnosticActivate' });
          }
      }
      // 激活标签可能展开组，最后再恢复归档中的折叠状态。
      for (const group of snapshot.groups) {
        const restored = job.groups.find((entry) => entry.key === group.key);
        if (restored)
          try {
            await browser.collapseGroup(restored.id, group.collapsed);
          } catch (error: unknown) {
            console.error('Could not restore group collapse state', error);
            job.errors.push({ key: 'diagnosticCollapse' });
          }
      }
      try {
        await browser.applyWindow(created.windowId, snapshot);
      } catch (error: unknown) {
        console.error('Could not restore window state', error);
        job.errors.push({ key: 'diagnosticApplyWindow' });
      }
      try {
        job.errors.push(...(await browser.verify(job, snapshot)));
      } catch (error: unknown) {
        console.error('Could not verify restored window', error);
        job.errors.push({ key: 'diagnosticVerify' });
      }
      // 网页进度与浏览器标签结构分别记录；进度失败不改变“恢复并移除”的结构判定。
      job.progressWarnings = (
        await Promise.all(
          ordered.flatMap((tab) => {
            const restored = job.tabs.find((entry) => entry.key === tab.key);
            if (!restored || !tab.progress) return [];
            return [
              browser
                .restoreProgress(restored.id, tab.progress)
                .then((warnings) => warnings)
                .catch((error: unknown) => {
                  console.error('Could not restore browsing progress', error);
                  return [{ key: 'diagnosticProgress' } as Diagnostic];
                }),
            ];
          }),
        )
      ).flat();
      await repository.save(job);
      job.state =
        job.errors.length === 0 && job.tabs.length === job.totalTabs ? 'complete' : 'partial';
      const result = await repository.finish(job);
      changed();
      return result;
    } catch (error: unknown) {
      job.state = 'partial';
      job.errors.push(diagnosticFromError(error, 'diagnosticRestoreStopped'));
      try {
        await repository.finish(job);
      } catch {
        job.errors.push({ key: 'diagnosticRestoreWriteFailed' });
      }
      changed();
      return job;
    }
  }
}
