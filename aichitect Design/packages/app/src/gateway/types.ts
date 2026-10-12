/**
 * 渲染层网关抽象（P007/P010）
 *
 * UI 不感知具体实现：UnavailableGatewayClient（网关未就绪，所有调用抛错/下发 error 信封）
 * 与 IpcGatewayClient（Electron IPC 桥 → 主进程 → agent-service HTTP/SSE）实现同一接口，
 * 由 App 按 GatewayStatus.gateway 选择：'bridge' → IPC 桥；'none' → 不可用客户端。
 *
 * 无本地数据兜底：未连接网关时对话/图像一律显式报错，不做离线模拟。
 */
import type { AgentRequest, AgentResponse, GatewayStatus, RunOptions, SseDeltaData, SseEventEnvelope, SseEventType, SseThinkingData, SseToolData, SseUsageData } from '../types/contracts';

/** SSE 事件处理器（信封语义见 contracts.ts：delta|progress|done|error|partial|usage） */
export interface StreamHandlers {
  onDelta?: (delta: string) => void;
  onProgress?: (progress: unknown) => void;
  onDone?: (response: AgentResponse) => void;
  onError?: (error: { code: string; message: string }) => void;
  onPartial?: (partial: unknown) => void;
  /** R6-6：模型思考增量 */
  onThinking?: (delta: string) => void;
  /** R6-6：工具调用可见性 */
  onTool?: (info: { toolName: string; phase: 'start' | 'end'; error?: string }) => void;
  /** R7-2：模型用量（每次 LLM 调用一轮；API 实报值 + 上下文构成估算） */
  onUsage?: (usage: SseUsageData) => void;
}

export interface GatewayClient {
  /** 查询网关状态 */
  getStatus(): Promise<GatewayStatus>;
  /** 发出请求 → { requestId }（与 /v1/run 语义一致；runOptions 携带 agent/model/thinking） */
  run(req: AgentRequest, runOptions?: RunOptions): Promise<{ requestId: string }>;
  /** 订阅指定 requestId 的事件流；返回退订函数 */
  subscribe(requestId: string, handlers: StreamHandlers): () => void;
  /** 取消指定 requestId 的流 */
  cancel(requestId: string): Promise<void>;
}

/** 按信封 type 分发到对应回调（不可用客户端与 IPC 桥共用） */
export function dispatchEnvelope(envelope: SseEventEnvelope, handlers: StreamHandlers): void {
switch (envelope.type satisfies SseEventType) {
    case 'delta':
      handlers.onDelta?.((envelope.data as SseDeltaData).delta);
      break;
    case 'progress':
      handlers.onProgress?.(envelope.data);
      break;
    case 'done':
      handlers.onDone?.(envelope.data as AgentResponse);
      break;
    case 'error':
      handlers.onError?.(envelope.data as { code: string; message: string });
      break;
    case 'partial':
      handlers.onPartial?.(envelope.data);
      break;
    case 'thinking':
      handlers.onThinking?.((envelope.data as SseThinkingData).delta);
      break;
    case 'tool':
      handlers.onTool?.(envelope.data as SseToolData);
      break;
    case 'usage':
      handlers.onUsage?.(envelope.data as SseUsageData);
      break;
    default:
      break;
  }
}