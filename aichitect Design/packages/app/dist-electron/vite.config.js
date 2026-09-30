/**
 * AICH Design 渲染进程构建配置（P007）
 * - 渲染进程 = React + Vite + TypeScript（设计文档 §1.1 T4 / §10）
 * - 主进程/preload 由 tsconfig.electron.json 编译至 dist-electron/，Vite 不参与
 * - test（P014）：vitest 对纯函数核心（svgToPng / mockImage）以注入式 mock 覆盖，
 *   environment: 'node'（纯逻辑无需 DOM；canvas/Image 均为注入 mock）
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    base: './',
    server: {
        port: 5173,
        strictPort: true
    },
    build: {
        outDir: 'dist-renderer',
        emptyOutDir: true
    },
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
    }
});
//# sourceMappingURL=vite.config.js.map