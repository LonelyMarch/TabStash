import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

/**
 * 配置 Edge / Chrome 共用的 Manifest V3 扩展与 Side Panel 样式构建。
 *
 * WXT 会从 sidepanel 入口生成侧栏路径。当前只申请读取标签标题所需的
 * tabs 权限、读取标签组所需的 tabGroups 权限，以及打开侧栏所需的
 * sidePanel 权限。storage 权限用于本地设置及短时会话记录，favicon 权限
 * 用于在标签未提供图标时读取浏览器自身的 favicon。IndexedDB 保存归档和操作日志，
 * 网页进度功能需要顶层页面内容脚本，因此申请网站访问权限；浏览器内部页仍不可注入。
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    // Tailwind 4 通过 Vite 插件处理侧栏 CSS，不新增独立的 PostCSS 配置。
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'TabStash',
    description: '__MSG_extensionDescription__',
    default_locale: 'en',
    version: '0.1.0',
    minimum_chrome_version: '116',
    permissions: ['tabs', 'tabGroups', 'sidePanel', 'storage', 'favicon'],
    host_permissions: ['<all_urls>'],
    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png',
    },
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' },
    },
  },
});
