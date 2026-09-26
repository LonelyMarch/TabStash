import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import type { MediaProgress, PageProgress, ScrollProgress } from '../src/domain/archive/models';
import type { Diagnostic } from '../src/i18n/core';

const DOCUMENT_PATH = 'document';
const MAX_SCROLLS = 20;
const MAX_MEDIA = 4;

/**
 * 使用标签类型与同类元素序号定位元素，不读取或保存网页文本、表单值和属性内容。
 * @param element 需要在重新加载后重新寻找的滚动区域或媒体元素。
 */
function elementPath(element: Element): string | null {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    let position = 1;
    let previous = current.previousElementSibling;
    while (previous) {
      if (previous.tagName === current.tagName) position += 1;
      previous = previous.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${position})`);
    current = current.parentElement;
  }
  const path = `html > ${parts.join(' > ')}`;
  return path.length <= 240 ? path : null;
}

/** @param element 页面或内层滚动区域；max 值用于窗口尺寸变化后的比例还原。 */
function scrollPosition(element: Element, path: string): ScrollProgress {
  const root =
    path === DOCUMENT_PATH ? (document.scrollingElement ?? document.documentElement) : element;
  return {
    path,
    top: Math.max(0, root.scrollTop),
    left: Math.max(0, root.scrollLeft),
    maxTop: Math.max(0, root.scrollHeight - root.clientHeight),
    maxLeft: Math.max(0, root.scrollWidth - root.clientWidth),
  };
}

/**
 * 补查事件监听建立前或同一任务内刚变化的内层滚动区域；最多查看 3000 个元素。
 * @param candidates 已知的内层滚动区域，调用方继续复用此集合。
 */
function discoverScrolledElements(candidates: Set<Element>): void {
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let inspected = 0; inspected < 3000 && candidates.size < MAX_SCROLLS; inspected += 1) {
    const node = walker.nextNode();
    if (!node) break;
    const element = node as Element;
    if (element !== document.scrollingElement && (element.scrollTop > 0 || element.scrollLeft > 0))
      candidates.add(element);
  }
}

/**
 * 在顶层页面采集有限的滚动和原生媒体位置；不可定位的元素直接跳过。
 * @param candidates 用户实际滚动过的内层区域，避免每次遍历整个网页。
 */
function captureProgress(candidates: Set<Element>, discover = false): PageProgress {
  if (discover) discoverScrolledElements(candidates);
  const scrolls = [scrollPosition(document.documentElement, DOCUMENT_PATH)];
  for (const element of candidates) {
    if (scrolls.length > MAX_SCROLLS) break;
    if (!element.isConnected) {
      candidates.delete(element);
      continue;
    }
    const path = elementPath(element);
    if (path && (element.scrollTop > 0 || element.scrollLeft > 0))
      scrolls.push(scrollPosition(element, path));
  }
  const media: MediaProgress[] = [];
  for (const element of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (media.length >= MAX_MEDIA) break;
    const path = elementPath(element);
    if (
      path &&
      Number.isFinite(element.duration) &&
      element.duration > 0 &&
      Number.isFinite(element.currentTime) &&
      element.currentTime > 0
    )
      media.push({
        path,
        kind: element.tagName.toLowerCase() as 'audio' | 'video',
        time: element.currentTime,
        duration: element.duration,
      });
  }
  return { url: location.href, scrolls, media };
}

/** @param saved 归档时的位置；页面尺寸变化明显时改用比例，避免跳到错误段落。 */
function targetPosition(saved: number, savedMax: number, currentMax: number): number {
  if (savedMax <= 0) return Math.min(saved, currentMax);
  const ratio = currentMax / savedMax;
  return Math.min(
    currentMax,
    ratio >= 0.9 && ratio <= 1.1 ? saved : (saved / savedMax) * currentMax,
  );
}

/**
 * 等待延迟渲染的区域与媒体元数据，限时定位后返回可见警告，不自动播放媒体。
 * @param progress 已通过后台持久化的页面进度。
 */
async function restoreProgress(
  progress: PageProgress,
  hasUserInteracted: () => boolean,
): Promise<{ warnings: Diagnostic[] }> {
  if (location.href !== progress.url) return { warnings: [{ key: 'diagnosticUrlChanged' }] };
  if (hasUserInteracted()) return { warnings: [{ key: 'diagnosticUserInteracted' }] };
  let userInteracted = false;
  const stopForUser = () => {
    userInteracted = true;
  };
  for (const event of ['wheel', 'touchstart', 'keydown', 'pointerdown'])
    window.addEventListener(event, stopForUser, { once: true, capture: true });
  const pendingScrolls = new Set(progress.scrolls);
  const pendingMedia = new Set(progress.media);
  let unsupportedMedia = false;
  const deadline = Date.now() + 10_000;
  try {
    while ((pendingScrolls.size || pendingMedia.size) && Date.now() < deadline) {
      if (userInteracted || location.href !== progress.url) break;
      for (const item of pendingScrolls) {
        const element =
          item.path === DOCUMENT_PATH
            ? (document.scrollingElement ?? document.documentElement)
            : document.querySelector(item.path);
        if (!element) continue;
        const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
        const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
        if ((item.top > 0 && maxTop === 0) || (item.left > 0 && maxLeft === 0)) continue;
        element.scrollTop = targetPosition(item.top, item.maxTop, maxTop);
        element.scrollLeft = targetPosition(item.left, item.maxLeft, maxLeft);
        if (
          Math.abs(element.scrollTop - targetPosition(item.top, item.maxTop, maxTop)) <= 8 &&
          Math.abs(element.scrollLeft - targetPosition(item.left, item.maxLeft, maxLeft)) <= 8
        )
          pendingScrolls.delete(item);
      }
      for (const item of pendingMedia) {
        const element = document.querySelector(item.path);
        if (!(element instanceof HTMLMediaElement) || element.readyState < 1) continue;
        if (!Number.isFinite(element.duration) || Math.abs(element.duration - item.duration) > 2) {
          unsupportedMedia = true;
          pendingMedia.delete(item);
          continue;
        }
        try {
          element.currentTime = Math.min(item.time, Math.max(0, element.duration - 0.1));
          if (Math.abs(element.currentTime - item.time) <= 1) pendingMedia.delete(item);
        } catch {
          // 网站或媒体格式可能禁止 seek；到时限后将它报告为未还原。
        }
      }
      if (pendingScrolls.size || pendingMedia.size)
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    for (const event of ['wheel', 'touchstart', 'keydown', 'pointerdown'])
      window.removeEventListener(event, stopForUser, true);
  }
  const warnings: Diagnostic[] = [];
  if (pendingScrolls.size) warnings.push({ key: 'diagnosticScroll' });
  if (pendingMedia.size || unsupportedMedia) warnings.push({ key: 'diagnosticMedia' });
  return { warnings };
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  /** 每个顶层网页各自维护检查点，不接触其他扩展或浏览器内部页面。 */
  main() {
    if (window.top !== window) return;
    const candidates = new Set<Element>();
    let userInteracted = false;
    /** 保存内容脚本启动后的真实输入，防止恢复消息晚于用户滚动而覆盖新位置。 */
    for (const event of ['wheel', 'touchstart', 'keydown', 'pointerdown'])
      window.addEventListener(
        event,
        (input) => {
          if (input.isTrusted) userInteracted = true;
        },
        { capture: true },
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 对高频滚动和 timeupdate 合并写入；页面离开时直接发送最后一份。 */
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      void browser.runtime
        .sendMessage({
          type: 'tabstash:progress-checkpoint',
          progress: captureProgress(candidates),
        })
        .catch(() => undefined);
    };
    const schedule = () => {
      if (timer === undefined) timer = setTimeout(flush, 1000);
    };
    document.addEventListener(
      'scroll',
      (event) => {
        if (event.target instanceof Element && event.target !== document.scrollingElement)
          candidates.add(event.target);
        schedule();
      },
      true,
    );
    document.addEventListener('timeupdate', schedule, true);
    document.addEventListener('seeked', schedule, true);
    document.addEventListener('pause', schedule, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    // 部分网站在脚本启动前已恢复内层滚动条，扫描一次非零位置补足事件记录。
    discoverScrolledElements(candidates);
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const request = message as { type?: string; progress?: PageProgress };
      if (request.type === 'tabstash:capture-progress')
        return Promise.resolve(captureProgress(candidates, true));
      if (request.type === 'tabstash:restore-progress' && request.progress)
        return restoreProgress(request.progress, () => userInteracted);
    });
    // 首次检查点覆盖浏览器在脚本启动前自动还原的主页面位置。
    schedule();
  },
});
