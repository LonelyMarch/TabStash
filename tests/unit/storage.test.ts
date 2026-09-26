import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../src/infrastructure/storage/session';
import { SettingsStore, type StorageArea } from '../../src/infrastructure/storage/settings';

/** 模拟浏览器存储的结构化克隆语义，可独立注入读写失败。 */
function memoryArea(): StorageArea {
  const values: Record<string, unknown> = {};
  return {
    get: async (key) => structuredClone(key in values ? { [key]: values[key] } : {}),
    set: async (input) => {
      Object.assign(values, structuredClone(input));
    },
    remove: async (key) => {
      delete values[key];
    },
  };
}

describe('本地设置', () => {
  it('首次读取默认关闭，写入后新实例读到持久设置', async () => {
    const area = memoryArea();
    const store = new SettingsStore(area);
    expect(await store.get()).toEqual({ autoArchiveClosedWindows: false });
    await store.update({ autoArchiveClosedWindows: true });
    expect(await new SettingsStore(area).get()).toEqual({ autoArchiveClosedWindows: true });
  });

  it('读取失败和数据损坏不会被伪装成默认设置', async () => {
    const area = memoryArea();
    vi.spyOn(area, 'get').mockRejectedValueOnce(new Error('读取被拒绝'));
    await expect(new SettingsStore(area).get()).rejects.toThrow('读取被拒绝');
    await area.set({ 'tabstash.settings.v1': { autoArchiveClosedWindows: 'yes' } });
    await expect(new SettingsStore(area).get()).rejects.toThrow('格式无效');
  });

  it('写入失败不报告成功，也不改变原先已保存的值', async () => {
    const area = memoryArea();
    const store = new SettingsStore(area);
    await store.update({ autoArchiveClosedWindows: false });
    vi.spyOn(area, 'set').mockRejectedValueOnce(new Error('超出配额'));
    await expect(store.update({ autoArchiveClosedWindows: true })).rejects.toThrow('超出配额');
    expect(await store.get()).toEqual({ autoArchiveClosedWindows: false });
  });
});

describe('Worker 会话与关闭抑制', () => {
  it('并发初始化使用同一 ID，Worker 重建后复用，session 清空后更换', async () => {
    const area = memoryArea();
    const store = new SessionStore(area);
    const ids = await Promise.all([store.getSessionId(), store.getSessionId()]);
    expect(ids[0]).toBe(ids[1]);
    expect(await new SessionStore(area).getSessionId()).toBe(ids[0]);
    expect(await new SessionStore(memoryArea()).getSessionId()).not.toBe(ids[0]);
  });

  it('初始化写入失败后允许重试，不把未持久化 ID 返回给业务', async () => {
    const area = memoryArea();
    vi.spyOn(area, 'set').mockRejectedValueOnce(new Error('会话写入失败'));
    const store = new SessionStore(area);
    await expect(store.getSessionId()).rejects.toThrow('会话写入失败');
    const id = await store.getSessionId();
    expect(await new SessionStore(area).getSessionId()).toBe(id);
  });

  it('抑制跨 Worker 重建保留，到期或窗口不匹配时不生效', async () => {
    const area = memoryArea();
    const store = new SessionStore(area);
    const record = {
      sessionId: await store.getSessionId(),
      windowId: 7,
      archiveId: 'archive-1',
      operationId: 'operation-1',
      expiresAt: 200,
    };
    await store.saveSuppression(record);
    const restarted = new SessionStore(area);
    expect(await restarted.getSuppression(7, 199)).toEqual(record);
    expect(await restarted.getSuppression(7, 200)).toBeUndefined();
    expect(await restarted.getSuppression(8, 199)).toBeUndefined();
    await restarted.removeSuppression(7);
    expect(await restarted.getSuppression(7, 199)).toBeUndefined();
  });

  it('旧会话的抑制不能生效或写入当前会话', async () => {
    const area = memoryArea();
    const store = new SessionStore(area);
    const record = {
      sessionId: 'old-session',
      windowId: 7,
      archiveId: 'a',
      operationId: 'o',
      expiresAt: 200,
    };
    await expect(store.saveSuppression(record)).rejects.toThrow('当前会话');
    await area.set({ 'tabstash.close-suppression.v1.7': record });
    expect(await store.getSuppression(7, 100)).toBeUndefined();
  });
});
