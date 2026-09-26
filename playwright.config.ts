import { defineConfig } from '@playwright/test';

/** 使用本机 Edge 和独立临时配置目录测试生产扩展，不下载或依赖 Chrome。 */
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
});
