/**
 * UnavailableGatewayClient —— 本地网关不可用时的 fail-closed 客户端。
 *
 * 用途：取代早先的本地 mock 数据层。当 Electron bridge 缺失（浏览器直开）或
 * agent-service 未就绪时，用它作为 `GatewayClient` 的占位实现——不产生任何模拟数据，
 * run() 直接拒绝、subscribe() 立即投递一条错误信封，由 UI 展示可操作的提示。
 *
 * 这样 `useGateway` 的 clientRef 始终有合法实现，调用点无需到处判空。
 */

import { ErrorCode } from '@aichdesign/shared';
import type { AgentRequest, GatewayStatus, RunOptions, SseEventEnvelope } from '../types/contracts';
import type { GatewayClient, StreamHandlers } from './types';
import { dispatchEnvelope } from './types';

/** 未连接提示文案（UI 直接展示，须可操作）。 */
export const GATEWAY_OFFLINE_MESSAGE =
  '未连接本地网关：agent-service 未就绪。请在「设置 → LLM 端点 / 图像端点」完成配置后重启本地服务。';

export class UnavailableGatewayClient implements GatewayClient {
  async getStatus(): Promise<GatewayStatus> {
    return { agentService: 'unavailable', gateway: 'none' };
  }

  async run(_req: AgentRequest, _runOptions?: RunOptions): Promise<{ requestId: string }> {
    throw new Error(GATEWAY_OFFLINE_MESSAGE);
  }

  subscribe(requestId: string, handlers: StreamHandlers): () => void {
    const envelope: SseEventEnvelope = {
      requestId,
      sessionId: '',
      type: 'error',
      data: { code: ErrorCode.PROVIDER_UNAVAILABLE, message: GATEWAY_OFFLINE_MESSAGE },
    };
    const timer = setTimeout(() => dispatchEnvelope(envelope, handlers), 0);
    return () => clearTimeout(timer);
  }

  async cancel(_requestId: string): Promise<void> {
    // 无在途运行可取消。
  }
}

/** 渲染层单例（网关不可用时由 useGateway 选中）。 */
export const unavailableGateway = new UnavailableGatewayClient();

/** 客户端是否可真实发起请求（false = 占位桩，调用必然报错）。 */
export function isGatewayAvailable(client: GatewayClient): boolean {
  return client !== (unavailableGateway as GatewayClient);
}
