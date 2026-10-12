/**
 * useSessions —— 会话历史管理（P-R3 前端重构）。
 *
 * - 列表：主进程 sessions:list（读 sessions/*.jsonl 摘要）；无 bridge（浏览器直开）→ 空列表
 * - 当前会话：sessionId 状态（新会话 = s-<uuid>，符合后端 SESSION_ID_RE 白名单）
 * - 切换/新建由 App 编排（配合 useConversation.reset/restore）
 */

import { useCallback, useEffect, useState } from 'react';
import type { SessionSummary } from '../types/contracts';

/** 新会话 id（白名单 ^[A-Za-z0-9._-]{1,64}$ 兼容）。 */
export function newSessionId(): string {
  return `s-${crypto.randomUUID()}`;
}

export interface UseSessionsResult {
  sessions: SessionSummary[];
  /** 重新扫描会话目录（新消息落盘后刷新左侧列表） */
  refresh: () => Promise<void>;
}

export function useSessions(): UseSessionsResult {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  const refresh = useCallback(async () => {
    const bridge = window.aichBridge;
    if (!bridge?.listSessions) return;
    try {
      setSessions(await bridge.listSessions());
    } catch {
      setSessions([]); // bridge 异常降级为空列表（不阻塞 UI）
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sessions, refresh };
}
