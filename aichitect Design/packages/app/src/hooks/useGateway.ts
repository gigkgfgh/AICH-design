/**
 * useGateway —— 网关状态与客户端选择（从 App.tsx 抽出，P-R3 重构；P016 接线轮加 refresh）。
 *
 * Electron bridge 且网关可用 → IpcGatewayClient；否则 UnavailableGatewayClient
 * （fail-closed：不产生模拟数据，请求直接报错并提示完成配置）。
 * refresh() 供服务重启后（Key 保存）重新探测。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GatewayStatus } from '../types/contracts';
import type { GatewayClient } from '../gateway/types';
import { unavailableGateway } from '../gateway/unavailableGateway';
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
  const clientRef = useRef<GatewayClient>(unavailableGateway);
  const stable: { current: GatewayClient } = clientRef;

  const probe = useCallback(async (): Promise<void> => {
    const bridge = window.aichBridge;
    if (!bridge) {
      clientRef.current = unavailableGateway;
      setStatus({ agentService: 'unavailable', gateway: 'none' });
      return;
    }
    try {
      const s = await bridge.getGatewayStatus();
      clientRef.current = s.gateway === 'bridge' ? new IpcGatewayClient(bridge) : unavailableGateway;
      setStatus(s);
    } catch {
      clientRef.current = unavailableGateway;
      setStatus({ agentService: 'unavailable', gateway: 'none' });
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  return { status, client: stable, refresh: probe };
}
