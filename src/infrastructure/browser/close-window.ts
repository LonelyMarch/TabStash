/** 关闭窗口所需的最小浏览器接口，便于模拟 API 成功但窗口仍存在的情况。 */
interface CloseWindowApi {
  remove(windowId: number): Promise<void>;
  getAll(): Promise<{ id?: number | undefined }[]>;
}

/**
 * 关闭后核对实际窗口列表，避免把浏览器确认或延迟阻止的关闭报告为成功。
 * @param windowId 本次用户明确请求关闭的窗口。
 * @param api 浏览器窗口接口；读取失败同样向上传递，不推断关闭成功。
 */
export async function closeWindowVerified(windowId: number, api: CloseWindowApi): Promise<void> {
  await api.remove(windowId);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await api.getAll()).some((window) => window.id === windowId)) return;
    // 允许正常异步关闭完成，但不重新发送关闭请求或操作浏览器确认界面。
    if (attempt < 19) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new AppError({ key: 'diagnosticCloseFailed' });
}

import { AppError } from '../../i18n/core';
