import { describe, expect, it } from 'vitest';
import {
  STREAM_WATCHDOG_MS,
  shouldDisableComposerInput,
  shouldFinalizeOnWatchdog,
  watchdogTimeoutMessage,
} from './streamWatchdog';

describe('流式看门狗判定', () => {
  it('看门狗时限为 5 分钟（远大于正常响应，又不至于久等）', () => {
    expect(STREAM_WATCHDOG_MS).toBe(5 * 60 * 1000);
  });

  it('仍盯着同一 requestId → 应收尾（恢复输入框）', () => {
    expect(shouldFinalizeOnWatchdog('r1', 'r1')).toBe(true);
  });

  it('已切换到别的 run → 放弃收尾，避免误伤后续请求', () => {
    expect(shouldFinalizeOnWatchdog('r2', 'r1')).toBe(false);
  });

  it('未武装（null）→ 放弃收尾', () => {
    expect(shouldFinalizeOnWatchdog(null, 'r1')).toBe(false);
  });

  it('超时文案含时长与可操作提示，不静默恢复', () => {
    const msg = watchdogTimeoutMessage();
    expect(msg).toContain('5');
    expect(msg).toContain('已中断');
    expect(msg).toContain('检查本地服务状态');
  });

  it('文案可按自定义时限生成', () => {
    expect(watchdogTimeoutMessage(10 * 60 * 1000)).toContain('10');
  });
});

describe('输入框禁用策略', () => {
  it('任何情况下都不禁用输入框（这正是「光标消失」的根因）', () => {
    expect(shouldDisableComposerInput(false)).toBe(false);
    expect(shouldDisableComposerInput(true)).toBe(false);
  });
});