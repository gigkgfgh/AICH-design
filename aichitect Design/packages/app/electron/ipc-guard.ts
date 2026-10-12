/**
 * E9：IPC sender 校验的纯判定逻辑（与 electron 主进程解耦，便于单测）。
 *
 * 背景：`ipcMain.handle` 注册的通道对**所有** WebContents 可见。同机其他应用/被注入的
 * 页面若取得调用能力，即可驱动主进程的网关、密钥、文件读取等敏感操作。
 *
 * 判定条件（两条同时满足才算可信）：
 * 1. `event.sender` 是本进程唯一窗口的 webContents——排除其他窗口/其他 WebContents；
 * 2. `event.senderFrame` 是该 webContents 的**主 frame**——排除渲染进程内 iframe 注入
 *    （contextBridge 只暴露给顶层，iframe 拿不到桥，但仍可能尝试直接 invoke）。
 */

/** 判定所需的最小结构（与 Electron IpcMainInvokeEvent 结构兼容）。 */
export interface IpcSenderLike {
  sender: unknown;
  senderFrame: unknown;
}

/** 判定所需的最小 WebContents 结构（与 Electron WebContents 结构兼容）。 */
export interface WebContentsLike {
  isDestroyed(): boolean;
  mainFrame: unknown;
}

/**
 * 调用方是否可信。
 * mainWebContents 为 null/已销毁一律视为不可信（fail-closed）。
 */
export function isTrustedIpcSender(
  event: IpcSenderLike,
  mainWebContents: WebContentsLike | null | undefined,
): boolean {
  if (!mainWebContents || mainWebContents.isDestroyed()) return false;
  if (event.sender !== mainWebContents) return false;
  // 主 frame 判定：iframe 的 senderFrame 与顶层 mainFrame 不是同一对象。
  return event.senderFrame === mainWebContents.mainFrame;
}
