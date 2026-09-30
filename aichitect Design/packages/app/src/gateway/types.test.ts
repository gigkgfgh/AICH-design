/**
 * R7-2：SSE usage 事件分发测试——信封 → onUsage 回调；未知类型静默（旧渲染层兼容）。
 */
import { describe, expect, it, vi } from 'vitest';
import { dispatchEnvelope, type StreamHandlers } from './types';
import type { SseUsageData } from '../types/contracts';

const USAGE: SseUsageData = {
  promptTokens: 1600,
  completionTokens: 300,
  cacheReadTokens: 1000,
  cacheWriteTokens: 0,
  totalTokens: 1900,
  context: { systemTokens: 320, toolTokens: 900, contextWindow: 1_000_000 },
};

function envelope(type: string, data: unknown) {
  return { requestId: 'r1', sessionId: 's1', type: type as never, data };
}

describe('dispatchEnvelope：usage 事件（R7-2）', () => {
  it('usage 信封 → onUsage 载荷透传', () => {
    const onUsage = vi.fn();
    const handlers: StreamHandlers = { onUsage };
    dispatchEnvelope(envelope('usage', USAGE), handlers);
    expect(onUsage).toHaveBeenCalledWith(USAGE);
  });

  it('旧 handler（无 onUsage）收到 usage 信封不抛错', () => {
    expect(() => dispatchEnvelope(envelope('usage', USAGE), {})).not.toThrow();
  });
});
