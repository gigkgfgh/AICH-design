/**
 * 流式看门狗的**状态判定**纯逻辑（便于在无 React 运行时的环境单测）。
 *
 * 背景：「输入框光标消失、无法输入」的根因是 ChatPanel 曾用 `disabled={streaming}`
 * 锁住 textarea，而 streaming 仅在 onDone/onError 时复位。一旦终态丢失（主进程窗口
 * 重建期间广播丢失、网关热重载期间在途run 无人再泵流、SSE 被中间层静默丢弃），
 * streaming 永久为 true，输入框永久锁死，只能重启应用。
 *
 * 双保险：
 * 1) ChatPanel 已改为**不禁用**输入框（生成期间也可输入，仅拦发送）；
 * 2) 此看门狗保证 streaming 在有限时间内一定复位，不依赖对端正确性。
 *
 * 本模块只做判定，实际定时器在 useConversation 内（需访问 React state）。
 */

/** 看门狗时限：远大于正常响应耗时，又不至于让用户久等。 */
export const STREAM_WATCHDOG_MS = 5 * 60 * 1000;

/**
 * 武装/解除判定。
 *
 * @param watchedRequestId 当前被看门狗盯住的 requestId（null = 未武装）
 * @param incomingRequestId 定时器到期时携带的 requestId
 * @returns 是否应当收尾。false 表示中途已切换到别的 run，放弃收尾以免误伤。
 */
export function shouldFinalizeOnWatchdog(
  watchedRequestId: string | null,
  incomingRequestId: string,
): boolean {
  return watchedRequestId !== null && watchedRequestId === incomingRequestId;
}

/**
 * 输入框是否应处于禁用态。
 *
 * 保留此判定是为记录设计决策：**任何情况下都不禁用**（返回恒 false）。
 * 生成期间由 canSend 阻止发送，而非锁死输入——锁死会让用户以为应用卡住。
 */
export function shouldDisableComposerInput(_streaming: boolean): boolean {
  return false;
}

/** 超时提示文案（写入助手消息，让用户知道发生了什么而非静默恢复）。 */
export function watchdogTimeoutMessage(watchdogMs: number = STREAM_WATCHDOG_MS): string {
  const minutes = Math.round(watchdogMs / 60000);
  return `\n\n[已中断：超过 ${minutes} 分钟未收到任何响应。请检查本地服务状态后重试]`;
}