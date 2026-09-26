import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WindowSnapshot } from '../../src/domain/archive/models';
import { ShadowTracker } from '../../src/runtime/shadow-tracker';

/** 最小非空快照用于验证异步事件顺序，不模拟浏览器数据转换。 */
const snapshot: WindowSnapshot = {
  groups: [],
  tabs: [{ key: 't', url: 'https://example.com', title: '示例', index: 0, pinned: false }],
};
const captured = { snapshot, runtimeTabs: [{ key: 't', tabId: 101 }] };

/** 创建可手动完成的捕获，用于把关闭和新事件插入进行中的请求。 */
function deferredCapture() {
  let resolve!: (value: typeof captured) => void;
  const promise = new Promise<typeof captured>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe('窗口影子事件顺序', () => {
  it('捕获进行中收到整窗关闭，禁止覆盖原有持久影子', async () => {
    const deferred = deferredCapture();
    const capture = vi.fn(() => deferred.promise);
    const save = vi.fn(async () => undefined);
    const tracker = new ShadowTracker({ capture, save, getSessionId: async () => 's' });
    const job = tracker.refresh(1);
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
    tracker.markClosing(1);
    deferred.resolve(captured);
    await job;
    await tracker.refresh(1);
    expect(save).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('旧捕获在新请求之后返回时被丢弃，只保存新结果', async () => {
    const deferred = deferredCapture();
    const capture = vi
      .fn()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue(captured);
    const save = vi.fn(async () => undefined);
    const tracker = new ShadowTracker({ capture, save, getSessionId: async () => 's' });
    const oldJob = tracker.refresh(1);
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
    const newJob = tracker.refresh(1);
    deferred.resolve(captured);
    await Promise.all([oldJob, newJob]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's',
        runtimeWindowId: 1,
        snapshot,
        runtimeTabs: captured.runtimeTabs,
      }),
    );
  });

  it('关闭会取消去抖任务，之后的新建窗口可以重新捕获', async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => captured);
    const tracker = new ShadowTracker({
      capture,
      save: async () => undefined,
      getSessionId: async () => 's',
    });
    tracker.schedule(1);
    tracker.schedule(1);
    tracker.markClosing(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(capture).not.toHaveBeenCalled();
    tracker.markCreated(1);
    await tracker.refresh(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('写入失败留下错误，成功重试后清除，不报告保存成功', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('磁盘写入失败'))
      .mockResolvedValue(undefined);
    const tracker = new ShadowTracker({
      capture: async () => captured,
      save,
      getSessionId: async () => 's',
    });
    await tracker.refresh(1);
    expect(tracker.getFailures([1])).toEqual([{ key: 'diagnosticShadowFailed' }]);
    await tracker.refresh(1);
    expect(tracker.getFailures([1])).toEqual([]);
  });
});
