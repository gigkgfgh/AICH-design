/**
 * AICH Design 渲染进程构建配置（P007）
 * - 渲染进程 = React + Vite + TypeScript（设计文档 §1.1 T4 / §10）
 * - 主进程/preload 由 tsconfig.electron.json 编译至 dist-electron/，Vite 不参与
 * - test（P014）：vitest 覆盖渲染层纯函数与组件逻辑；environment: 'node'
 *   （纯逻辑无需 DOM；涉及 canvas/Image 的用例自行注入替身）
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    // 必须显式绑IPv4 回环：不设时vite 5 只监听 [::1]（IPv6 localhost），
    // 而 Electron 主进程探测的是 http://127.0.0.1:5173 —— 地址族不同，
    // 探测恒为 "fetch failed"，表现为 dev 窗口加载不到 dev server。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'electron/**/*.test.ts']
  }
});