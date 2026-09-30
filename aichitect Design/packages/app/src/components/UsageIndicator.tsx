/**
 * UsageIndicator —— 对话输入框下方模型用量指示器（R7-2，DSH 风格双胶囊）：
 * - 胶囊一：层叠数据图标（SVG）+ 累计 tok · 缓存命中 %；胶囊二：中性色环形进度（SVG）+ 上下文已用 %；
 *   两枚胶囊均可点击开合明细面板（图标一律 SVG，不用 emoji；环形不着彩色）；
 * - 明细面板：上半区上下文构成（系统提示词/工具定义/对话消息，静态估算标 ~）+ 进度条；
 *   下半区会话 Token 用量（缓存命中/未缓存输入/缓存读取/输出/思考——API 实报值累计）。
 * 数据口径对标 DeepSeek Harness（dsh-context）：分类估算、总量实报、按请求粒度。
 * 重启恢复：usage 来自 jsonl usage 行聚合（SessionContent.usage），contextWindow 缺失时环显示 —。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { SessionUsage } from '../hooks/useConversation';

/** token 数格式化：≥1M → x.xM；≥1000 → xx.xK；其余原值。 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((part / whole) * 100)));
}

/** 层叠数据图标（三层圆柱，stroke 随胶囊文字色）。 */
function DataIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="usage-pill__svg">
      <ellipse cx="8" cy="3.8" rx="5.4" ry="2.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.6 3.8v4.2c0 1.27 2.42 2.3 5.4 2.3s5.4-1.03 5.4-2.3V3.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.6 8v4.2c0 1.27 2.42 2.3 5.4 2.3s5.4-1.03 5.4-2.3V8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function UsageIndicator(props: { usage: SessionUsage }): ReactElement {
  const { usage } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 外点关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hasWindow = usage.contextWindow > 0;
  const ctxUsed = usage.lastPromptTokens;
  const ctxPct = pct(ctxUsed, usage.contextWindow);
  const promptTotal = usage.sessionInput + usage.sessionCacheRead + usage.sessionCacheWrite;
  const hitPct = pct(usage.sessionCacheRead, promptTotal);
  // 上下文构成：对话消息 = 最近一轮 prompt − 静态估算（钳 ≥0）
  const messageTokens = Math.max(0, usage.lastPromptTokens - usage.contextSystemTokens - usage.contextToolTokens);
  const ringR = 5;
  const ringC = 2 * Math.PI * ringR;

  return (
    <div className="usage-indicator" ref={rootRef}>
      {open && (
        <div className="usage-popover" role="dialog" aria-label="模型用量明细">
          <div className="usage-popover__section">
            <div className="usage-popover__head">
              <span>上下文已用 <b>{hasWindow ? `${ctxPct}%` : '—'}</b></span>
              <span className="usage-popover__value">
                ~{fmtTokens(ctxUsed)} / {hasWindow ? fmtTokens(usage.contextWindow) : '未配置'}
              </span>
            </div>
            <div className="usage-popover__bar" role="progressbar" aria-valuenow={ctxPct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${ctxPct}%` }} />
            </div>
            <ul className="usage-popover__rows">
              <li><span className="usage-popover__dot usage-popover__dot--sys" />系统提示词<span>~{fmtTokens(usage.contextSystemTokens)}</span></li>
              <li><span className="usage-popover__dot usage-popover__dot--tool" />工具定义<span>~{fmtTokens(usage.contextToolTokens)}</span></li>
              <li><span className="usage-popover__dot usage-popover__dot--msg" />对话消息<span>~{fmtTokens(messageTokens)}</span></li>
            </ul>
          </div>
          <div className="usage-popover__section">
            <div className="usage-popover__head">
              <span>Token 用量</span>
              <span className="usage-popover__value">{usage.sessionTotal.toLocaleString()} tok</span>
            </div>
            <ul className="usage-popover__rows">
              <li>缓存命中<span>{promptTotal > 0 ? `${hitPct}%` : '—'}</span></li>
              <li>未缓存输入<span>{usage.sessionInput.toLocaleString()} tok</span></li>
              <li>缓存读取<span>{usage.sessionCacheRead.toLocaleString()} tok</span></li>
              <li>输出<span>{usage.sessionOutput.toLocaleString()} tok</span></li>
              {usage.sessionReasoning > 0 && <li>思考<span>{usage.sessionReasoning.toLocaleString()} tok</span></li>}
            </ul>
          </div>
        </div>
      )}
      <div className="usage-pills">
        <button
          type="button"
          className="usage-pill"
          onClick={() => setOpen((v) => !v)}
          title="模型用量明细"
          aria-expanded={open}
        >
          <DataIcon />
          <span className="usage-pill__text">
            {fmtTokens(usage.sessionTotal)} tok · 缓存命中 {promptTotal > 0 ? `${hitPct}%` : '—'}
          </span>
        </button>
        <button
          type="button"
          className="usage-pill"
          onClick={() => setOpen((v) => !v)}
          title="上下文占用（最近一轮 prompt / 模型上下文窗口）"
          aria-expanded={open}
        >
          <svg className="usage-pill__ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r={ringR} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
            <circle
              cx="7" cy="7" r={ringR} fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeDasharray={`${(ringC * ctxPct) / 100} ${ringC}`}
              transform="rotate(-90 7 7)" strokeLinecap="round"
            />
          </svg>
          <span className="usage-pill__pct">{hasWindow ? `${ctxPct}%` : '—'}</span>
        </button>
      </div>
    </div>
  );
}
