/**
 * 渲染层网关抽象（P007/P010）
 *
 * UI 不感知具体实现：MockGatewayClient（本地 mock 全链路）与 IpcGatewayClient（Electron IPC 桥
 * → 主进程 → agent-service HTTP/SSE）实现同一接口，由 App 按 GatewayStatus.gateway 选择。
 *
 * mock 直连模式下默认使用 MockGatewayClient；
 * // TODO-API: 切换 backend 网关 —— 在 electron 壳内（agent-service ready）自动切 IpcGatewayClient。
 */
import type { AgentRequest, AgentResponse, GatewayStatus, RunOptions, SseDeltaData, SseEventEnvelope, SseEventType, SseThinkingData, SseToolData } from '../types/contracts';

/** SSE 事件处理器（信封语义见 contracts.ts：delta|progress|done|error|partial） */
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

/** 按信封 type 分发到对应回调（mock 与 IPC 共用） */
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
    default:
      break;
  }
}