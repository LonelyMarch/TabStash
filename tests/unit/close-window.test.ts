import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeWindowVerified } from '../../src/infrastructure/browser/close-window';

afterEach(() => vi.useRealTimers());

describe('关闭窗口结果核对', () => {
  it('API 返回成功但窗口仍存在时报告失败，只请求一次关闭', async () => {
    vi.useFakeTimers();
    const api = {
      remove: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue([{ id: 7 }]),
    };
    const result = expect(closeWindowVerified(7, api)).rejects.toThrow('diagnosticCloseFailed');
    await vi.runAllTimersAsync();
    await result;
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it('延迟关闭完成后才成功，其他窗口仍存在不影响结果', async () => {
    vi.useFakeTimers();
    const api = {
      remove: vi.fn().mockResolvedValue(undefined),
      getAll: vi
        .fn()
        .mockResolvedValueOnce([{ id: 7 }])
        .mockResolvedValue([{ id: 8 }]),
    };
    const result = closeWindowVerified(7, api);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeUndefined();
  });

  it('无法读取关闭结果时向上报告错误', async () => {
    const api = {
      remove: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockRejectedValue(new Error('读取失败')),
    };
    await expect(closeWindowVerified(7, api)).rejects.toThrow('读取失败');
  });
});
