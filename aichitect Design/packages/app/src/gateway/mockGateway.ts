/**
 * MockGatewayClient —— 本地 mock 全链路（P007/P010；R7-1 方案链路移除）
 *
 * 模拟真实链路语义：
 *   UI 发送 → run() 返回 requestId → subscribe() 收到 SSE 信封流
 *   （delta 文本增量 → done 携带 AgentResponse.stream）
 * 图像生成在 mock 模式由 useConversation 本地兜底（generateMockImageDataUrl），不经网关。
 *
 * TODO-API: 切换 backend 网关 —— agent-service ready 时由 IpcGatewayClient 替代本实现。
 */
import type { AgentRequest, AgentResponse, GatewayStatus, SseEventEnvelope } from '../types/contracts';
import type { GatewayClient, StreamHandlers } from './types';
import { dispatchEnvelope } from './types';
import { ErrorCode } from '@aichdesign/shared'; // 错误码表唯一权威（R011：对齐 shared 10 码）

const MOCK_SESSION_ID = 'mock-session-001';
const TICK_MS = 120; // 流式分片间隔（模拟网络节奏）

let seq = 0;
function nextId(): string {
  seq += 1;
  return `mock-${Date.now().toString(36)}-${seq}`;
}

/** 文本按字节安全切分（按字符切，中文友好） */
function chunkText(text: string, size = 9): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

export class MockGatewayClient implements GatewayClient {
  private readonly status: GatewayStatus = {
    agentService: 'unavailable',
    gateway: 'mock',
  };

  async getStatus(): Promise<GatewayStatus> {
    return this.status;
  }

  async run(req: AgentRequest, _runOptions?: import('../types/contracts').RunOptions): Promise<{ requestId: string }> {
    // 同步完成「执行」，subscribe 只负责回放信封流 —— 保持 run/subscribe 解耦，
    // 与真实链路（run 启动、stream 拉取）一致。
    const requestId = nextId();
    this.prepareResponse(requestId, req);
    return { requestId };
  }

  subscribe(requestId: string, handlers: StreamHandlers): () => void {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const pending = this.pending.get(requestId);
    if (!pending) {
      const envelope: SseEventEnvelope = {
        requestId,
        sessionId: MOCK_SESSION_ID,
        type: 'error',
        data: { code: ErrorCode.INTERNAL_ERROR, message: 'mock：未知 requestId（无法生成响应）' },
      };
      timers.push(setTimeout(() => dispatchEnvelope(envelope, handlers), 0));
      return () => timers.forEach(clearTimeout);
    }
    this.pending.delete(requestId);

    const { deltas, done } = pending;
    deltas.forEach((text, i) => {
      timers.push(
        setTimeout(() => {
          const envelope: SseEventEnvelope = {
            requestId,
            sessionId: MOCK_SESSION_ID,
            type: 'delta',
            data: { delta: text },
          };
          dispatchEnvelope(envelope, handlers);
        }, i * TICK_MS)
      );
    });
    timers.push(
      setTimeout(() => {
        const envelope: SseEventEnvelope = {
          requestId,
          sessionId: MOCK_SESSION_ID,
          type: 'done',
          data: done,
        };
        dispatchEnvelope(envelope, handlers);
      }, deltas.length * TICK_MS + 60)
    );
    return () => timers.forEach(clearTimeout);
  }

  async cancel(requestId: string): Promise<void> {
    this.pending.delete(requestId);
  }

  /* ---------------- mock 执行体（真实链路中由 agent-service 承担） ---------------- */

  private readonly pending = new Map<
    string,
    { deltas: string[]; done: AgentResponse }
  >();

  private prepareResponse(requestId: string, req: AgentRequest): void {
    switch (req.kind) {
      case 'chat':
      case 'research': {
        const prompt = req.prompt.length > 40 ? `${req.prompt.slice(0, 40)}…` : req.prompt;
        const text =
          req.kind === 'research'
            ? `【调研纪要（mock）】${prompt}\n\n联网检索未启用；配置真实 LLM 与检索端点后可获取实时案例与来源链接。`
            : `收到：「${prompt}」（mock 回复）。配置真实 LLM 端点后可获得完整对话能力。`;
        this.pending.set(requestId, {
          deltas: chunkText(text),
          done: { kind: 'stream', delta: text },
        });
        break;
      }
      default: {
        // genImage / editImage 在 mock 模式由 useConversation 本地兜底，正常不会到达网关。
        const done: AgentResponse = {
          kind: 'error',
          code: ErrorCode.INVALID_REQUEST,
          message: `mock 网关不支持请求类型 ${req.kind}（图像生成走本地兜底路径）`,
        };
        this.pending.set(requestId, { deltas: [], done });
        break;
      }
    }
  }
}

/** 渲染层默认单例（App 在 gateway='mock' 时使用） */
export const mockGateway = new MockGatewayClient();
