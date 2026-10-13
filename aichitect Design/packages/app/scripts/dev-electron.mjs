/**
 * dev:electron 启动器——先清理会破坏 Electron 的环境变量，再启动主进程。
 *
 * 背景：`ELECTRON_RUN_AS_NODE=1` 会让 electron 二进制退化为纯 Node 运行，
 * **不注入 app / BrowserWindow 等模块**。此时主进程 `import ... from 'electron'`
 * 会在 Node ESM loader 的 cjsPreparseModuleExports 抛
 * `TypeError: Cannot read properties of undefined (reading 'exports')`，进程直接退出。
 *
 * 该变量并非本项目设置，而是由外层环境注入——典型场景是基于 Electron 的 IDE
 * （VS Code / WorkBuddy 等）的集成终端会把它传染给子进程。开发者在这类终端里跑
 * `npm run dev` 时，electron 必然起不来（表现为窗口打不开或一闪即退）。
 *
 * 这里在启动前显式删除它，使 dev 在任何终端下行为一致。
 * 仅 dev 使用；打包产物（electron-builder 等）不受影响。
 *
 * 附加参数透传：`npm run dev:electron -- --in-process-gpu` 会原样传给 electron，
 * 用于绕过虚拟机 / 远程桌面 / 老旧显卡驱动下的 GPU 进程崩溃（表现为黑屏）。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

delete process.env.ELECTRON_RUN_AS_NODE;

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 经 electron 包的 cli.js 启动（跨平台；内部再按平台定位 dist 下的可执行文件）。
const require = createRequire(import.meta.url);
const electronCli = require.resolve("electron/cli.js", { paths: [appDir] });

const child = spawn(process.execPath, [electronCli, ".", ...process.argv.slice(2)], {
  cwd: appDir,
  stdio: "inherit",
  env: process.env,
});

const forward = (signal) => {
  if (child.pid) {
    try {
      child.kill(signal);
    } catch {
      // 子进程可能已退出
    }
  }
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => forward(signal));
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
