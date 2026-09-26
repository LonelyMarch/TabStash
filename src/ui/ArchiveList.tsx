import { ChevronDown, ChevronRight, Pin } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ArchivedWindow, RestoreJob, TabSnapshot } from '../domain/archive/models';
import { archiveTitle } from '../domain/archive/presentation';
import { onMessage, sendMessage } from '../infrastructure/messaging/protocol';
import { RestoreControls, restoreResultText } from './RestoreControls';
import { TabIcon } from './TabIcon';

/**
 * 使用实时树的标签行样式展示归档快照，不赋予无法执行的单标签激活行为。
 *
 * @param props.tab 已保存的标签及图标线索。
 * @param props.grouped 是否位于归档标签组内，用于匹配实时树的缩进。
 * @param props.active 是否为归档时的活动标签，仅还原快照中的选中样式。
 */
function SavedTab({
  tab,
  grouped,
  active,
}: {
  tab: TabSnapshot;
  grouped: boolean;
  active: boolean;
}) {
  const title = tab.title || tab.url || '无标题标签页';
  return (
    <div
      className={`tab-row saved-tab${grouped ? ' grouped' : ''}${active ? ' active' : ''}`}
      title={tab.url ?? title}
    >
      <TabIcon
        favIconUrl={tab.favIconUrl ?? null}
        key={`${tab.url ?? 'missing'}|${title}|${tab.favIconUrl ?? 'missing'}`}
        title={title}
        url={tab.url}
      />
      <span className="node-title">{title}</span>
      {tab.pinned ? <Pin aria-hidden="true" className="pinned-icon" size={12} /> : null}
    </div>
  );
}

/**
 * 展示不可变归档的窗口、组和标签层级，使用原生 details 保留键盘展开能力。
 * @param props.archives 已按置顶及时间排序的归档。
 * @param props.error 读取失败信息，与“没有归档”空状态区分。
 */
export function ArchiveList({ archives, error }: { archives: ArchivedWindow[]; error: string }) {
  const [issues, setIssues] = useState<RestoreJob[]>([]);
  const [issueError, setIssueError] = useState('');
  const [notice, setNotice] = useState('');
  // 恢复通知只触发读取持久回执，跨侧栏与后台重启仍可查看未完整成功的原因。
  useEffect(() => {
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('恢复记录读取超时')), 8000);
        });
        const result = await Promise.race([sendMessage('getRestoreIssues'), timeout]);
        if (current === generation) {
          setIssues(result);
          setIssueError('');
        }
      } catch (failure: unknown) {
        if (current === generation) setIssueError(`恢复记录读取失败：${String(failure)}`);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const remove = onMessage('restoreStateInvalidated', () => {
      void refresh();
    });
    void refresh();
    return () => {
      generation += 1;
      remove();
    };
  }, []);
  return (
    <section aria-labelledby="archive-heading" className="archive-section" data-native-keyboard>
      <div className="section-heading">
        <h2 id="archive-heading">已归档</h2>
        <span className="section-count">{archives.length}</span>
      </div>
      {notice ? (
        <output className="archive-feedback" aria-live="polite">
          {notice}
        </output>
      ) : null}
      {issueError ? (
        <p role="status" className="help-text">
          {issueError}
        </p>
      ) : null}
      {issues.length ? (
        <details className="restore-issues">
          <summary>最近恢复异常（{issues.length}）</summary>
          {issues.map((job) => (
            <p className="help-text" key={job.requestId}>
              {new Date(job.startedAt).toLocaleString()}：{restoreResultText(job)}
            </p>
          ))}
        </details>
      ) : null}
      {error ? (
        <p role="status" className="help-text">
          {error}
        </p>
      ) : null}
      {!error && archives.length === 0 ? (
        <p className="empty-state">还没有归档。使用窗口旁的归档按钮保存。</p>
      ) : null}
      {archives.map((archive) => {
        const ordered = [...archive.snapshot.tabs].sort((a, b) => a.index - b.index);
        const displayed = new Set<string>();
        return (
          <div className="archive-entry" key={archive.id}>
            <details className="archive-item">
              <summary>
                <span aria-hidden="true" className="archive-disclosure">
                  <ChevronRight className="archive-chevron-closed" size={14} />
                  <ChevronDown className="archive-chevron-open" size={14} />
                </span>
                <span aria-hidden="true" className="window-marker" />
                <span className="window-copy">
                  <strong>
                    {archive.pinned ? '★ ' : ''}
                    {archiveTitle(archive.snapshot)}
                  </strong>
                  <small>
                    {new Date(archive.archivedAt).toLocaleString()} ·{' '}
                    {archive.source === 'manual-close'
                      ? '归档并关闭'
                      : archive.source === 'manual'
                        ? '手动归档'
                        : '自动归档'}
                  </small>
                </span>
                <span className="tab-count">{ordered.length}</span>
              </summary>
              <div className="window-children">
                {ordered.map((tab) => {
                  const group = archive.snapshot.groups.find((entry) => entry.key === tab.groupKey);
                  if (!group)
                    return (
                      <SavedTab
                        active={tab.key === archive.snapshot.activeTabKey}
                        grouped={false}
                        key={tab.key}
                        tab={tab}
                      />
                    );
                  if (displayed.has(group.key)) return null;
                  displayed.add(group.key);
                  return (
                    <details className="saved-group" key={group.key} open>
                      <summary className="group-row">
                        <span aria-hidden="true" className="saved-group-disclosure">
                          <ChevronRight className="saved-group-chevron-closed" size={14} />
                          <ChevronDown className="saved-group-chevron-open" size={14} />
                        </span>
                        <span aria-hidden="true" className={`group-dot ${group.color}`} />
                        <span className="node-title">{group.title || '未命名标签组'}</span>
                        <span className="tab-count">
                          {ordered.filter((entry) => entry.groupKey === group.key).length}
                        </span>
                      </summary>
                      <div className="group-children">
                        {ordered
                          .filter((entry) => entry.groupKey === group.key)
                          .map((entry) => (
                            <SavedTab
                              active={entry.key === archive.snapshot.activeTabKey}
                              grouped
                              key={entry.key}
                              tab={entry}
                            />
                          ))}
                      </div>
                    </details>
                  );
                })}
              </div>
            </details>
            <RestoreControls archive={archive} onNotice={setNotice} />
          </div>
        );
      })}
    </section>
  );
}
