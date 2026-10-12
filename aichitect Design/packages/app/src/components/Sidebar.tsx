/**
 * Sidebar —— 左侧栏（P-R3 三列重构）：
 * 新建对话、历史会话列表（当前高亮/点击切换）、网关状态徽标、设置入口。
 */

import type { ReactElement } from 'react';
import type { GatewayStatus, SessionSummary } from '../types/contracts';

export interface SidebarProps {
  sessions: SessionSummary[];
  currentSessionId: string;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  gatewayStatus: GatewayStatus | null;
  onOpenSettings: () => void;
  /** R6-3：收起侧栏 */
  onCollapse?: () => void;
  /** R6-9：删除历史会话 */
  onDeleteSession?: (sessionId: string) => void;
}

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diffMs = Date.now() - t;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

export function Sidebar(props: SidebarProps): ReactElement {
  const { sessions, currentSessionId, onNewSession, onSelectSession, gatewayStatus, onOpenSettings, onCollapse, onDeleteSession } = props;
  const online = gatewayStatus?.gateway === 'bridge';
  const dotTitle = online
    ? '本地网关已连接'
    : gatewayStatus?.error?.message ?? '本地网关未连接：对话与图像功能不可用';

  return (
    <aside className="sidebar" aria-label="会话导航">
      <div className="sidebar__head">
        {/* R6-14：品牌移至自绘标题栏，此处仅保留网关状态与折叠按钮 */}
        <span className="sidebar__head-right">
          <span className={`sidebar__dot ${online ? 'is-online' : ''}`} title={dotTitle} />
          {onCollapse && (
            <button type="button" className="sidebar__collapse" onClick={onCollapse} title="收起侧栏" aria-label="收起侧栏">
              ‹
            </button>
          )}
        </span>
      </div>

      <button type="button" className="sidebar__new" onClick={onNewSession}>
        ＋ 新建对话
      </button>

      <nav className="sidebar__history" aria-label="历史会话">
        <p className="sidebar__section-title">历史对话</p>
        {sessions.length === 0 && (
          <p className="sidebar__empty">暂无历史会话（连接本地网关后自动同步）</p>
        )}
        <ul className="sidebar__list">
          {sessions.map((s) => {
            const active = s.sessionId === currentSessionId;
            return (
              <li key={s.sessionId} className={`sidebar__item ${active ? 'is-active' : ''}`}>
                <button
                  type="button"
                  className="sidebar__session-btn"
                  onClick={() => onSelectSession(s.sessionId)}
                  title={s.title}
                >
                  <span className="sidebar__session-title">{s.title}</span>
                  <span className="sidebar__session-meta-row">
                    <span className="sidebar__session-meta">
                      {formatRelativeTime(s.lastTs)} · {s.messageCount} 条
                    </span>
                    {onDeleteSession && (
                      <button
                        type="button"
                        className="sidebar__session-delete"
                        aria-label={`删除 ${s.title}`}
                        title="删除会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`删除会话「${s.title}」？该操作不可恢复。`)) {
                            onDeleteSession(s.sessionId);
                          }
                        }}
                      >
                        🗑
                      </button>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="sidebar__foot">
        <button type="button" className="sidebar__settings" onClick={onOpenSettings}>
          ⚙ 设置
        </button>
      </div>
    </aside>
  );
}
