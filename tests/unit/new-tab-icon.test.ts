import { describe, expect, it } from 'vitest';
import { isNewTabPage, newTabIconVariant } from '../../src/domain/window/new-tab-icon';

describe('新建标签页图标判断', () => {
  it('识别 Edge、Chrome 的内部新标签页及扩展接管后的页面', () => {
    expect(isNewTabPage('edge://newtab/', '新标签页')).toBe(true);
    expect(isNewTabPage('chrome://newtab/', 'New Tab')).toBe(true);
    expect(isNewTabPage('chrome-extension://abcdef/index.html', '新标签页')).toBe(true);
    expect(isNewTabPage('chrome-extension://abcdef/newtab.html', '自定义首页')).toBe(true);
  });

  it('不把普通内置页、普通扩展页和空白页误判为新标签页', () => {
    expect(isNewTabPage('edge://settings/profiles', '设置')).toBe(false);
    expect(isNewTabPage('edge://new-tab-page/', '内部页面')).toBe(false);
    expect(isNewTabPage('chrome-extension://abcdef/sidepanel.html', 'TabStash')).toBe(false);
    expect(isNewTabPage('about:blank', '新标签页')).toBe(false);
    expect(isNewTabPage('https://example.com/', 'New Tab')).toBe(false);
  });

  it('按浏览器品牌选择各自的图标', () => {
    expect(newTabIconVariant('Mozilla/5.0 Chrome/153.0 Edg/153.0')).toBe('edge');
    expect(newTabIconVariant('Mozilla/5.0 Chrome/153.0')).toBe('chromium');
  });
});
