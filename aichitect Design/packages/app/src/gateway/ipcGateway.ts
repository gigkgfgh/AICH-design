/**
 * IpcGatewayClient —— Electron IPC 桥网关（P007）
 *
 * 渲染层 → window.aichBridge（preload contextBridge）→ 主进程 → GatewayHttpClient
 * （HTTP POST /v1/run、GET /v1/stream/:requestId SSE、POST /v1/cancel，Bearer token）。
 *
 * 当 GatewayStatus.gateway === 'bridge' 时由 App 选用本实现；
 * TODO-API: P006 agent-service 就绪后启用（当前 agentService 未就绪，默认走 mock）。
 */
import type { AgentRequest, GatewayStatus, SseEventEnvelope } from '../types/contracts';
import type { GatewayClient, StreamHandlers } from './types';
import { dispatchEnvelope } from './types';

export class IpcGatewayClient implements GatewayClient {
  private readonly bridge: AichBridge;

  constructor(bridge: AichBridge) {
    this.bridge = bridge;
  }

  async getStatus(): Promise<GatewayStatus> {
    return this.bridge.getGatewayStatus();
  }

  async run(req: AgentRequest, runOptions?: import('../types/contracts').RunOptions): Promise<{ requestId: string }> {
    return this.bridge.runRequest(req, runOptions);
  }

  subscribe(requestId: string, handlers: StreamHandlers): () => void {
    // 主进程在 run 成功后自动 pump SSE 并 webContents.send('gateway:event') 推送
    return this.bridge.onGatewayEvent((envelope: SseEventEnvelope) => {
      if (envelope.requestId !== requestId) {
        return;
      }
      dispatchEnvelope(envelope, handlers);
    });
  }

  async cancel(requestId: string): Promise<void> {
    await this.bridge.cancelRequest(requestId);
  }
}