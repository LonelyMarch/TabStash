import { defineConfig } from 'vitest/config';

/**
 * 为纯业务规则配置无需浏览器页面的单元测试。
 *
 * 默认使用 Node 环境测试纯业务规则；键盘 DOM 回归测试通过文件头注解使用
 * happy-dom，验证 React 监听器和元素焦点。真实 Edge 跨窗口焦点仍需单独验收。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
