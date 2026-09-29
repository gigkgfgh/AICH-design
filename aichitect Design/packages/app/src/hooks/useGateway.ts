/**
 * useGateway —— 网关状态与客户端选择（从 App.tsx 抽出，P-R3 重构；P016 接线轮加 refresh）。
 *
 * Electron bridge 且 agent-service ready → IpcGatewayClient；否则 MockGatewayClient
 * （浏览器直开预览同样可用）。refresh() 供服务重启后（Key 保存）重新探测。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GatewayStatus } from '../types/contracts';
import type { GatewayClient } from '../gateway/types';
import { mockGateway } from '../gateway/mockGateway';
import { IpcGatewayClient } from '../gateway/ipcGateway';

export interface UseGatewayResult {
  status: GatewayStatus | null;
  /** 网关客户端（稳定容器；current 在探测完成后指向选定实现） */
  client: { current: GatewayClient };
  /** 重新探测（agent-service 重启后调用；进行中的旧状态保留直至新结果） */
  refresh: () => Promise<void>;
}

export function useGateway(): UseGatewayResult {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const clientRef = useRef<GatewayClient>(mockGateway);
  const stable: { current: GatewayClient } = clientRef;

  const probe = useCallback(async (): Promise<void> => {
    const bridge = window.aichBridge;
    if (!bridge) {
      clientRef.current = mockGateway;
      setStatus({ agentService: 'unavailable', gateway: 'mock' });
      return;
    }
    try {
      const s = await bridge.getGatewayStatus();
      clientRef.current = s.gateway === 'bridge' ? new IpcGatewayClient(bridge) : mockGateway;
      setStatus(s);
    } catch {
      clientRef.current = mockGateway;
      setStatus({ agentService: 'unavailable', gateway: 'mock' });
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  return { status, client: stable, refresh: probe };
}
