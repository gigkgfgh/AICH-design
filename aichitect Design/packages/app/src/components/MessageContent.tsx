/**
 * MessageContent —— 消息正文渲染（R6 渲染升级）：
 * - Markdown（react-markdown + remark-gfm：标题/列表/表格/代码/链接）；
 *   来源链接可点击 → 经 IPC 系统浏览器打开（仅 http/https，不内嵌渲染进程）
 * - plan 消息内嵌方案缩略图（SVG 直渲）→ 点击全屏大图（Esc/背景关闭）
 * - 安全：react-markdown 默认不解析原始 HTML（无 rehype-raw）；SVG 为自家渲染产物
 */

import { useEffect, useState, type ReactElement } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PlanVersion } from '../types/contracts';

/** Markdown 正文（assistant 消息）。 */
export function MarkdownContent(props: { text: string }): ReactElement {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              title={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//i.test(href)) {
                  // Electron 渲染进程不直接导航；经主进程 shell.openExternal 打开系统浏览器
                  void window.aichBridge?.openExternal?.(href).catch(() => {
                    window.open(href, '_blank', 'noopener');
                  });
                }
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {props.text}
      </Markdown>
    </div>
  );
}

/** plan 消息内嵌方案缩略图（点击 → 全屏大图）。 */
export function PlanThumb(props: { version: PlanVersion }): ReactElement {
  const [zoom, setZoom] = useState(false);
  const { version } = props;

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setZoom(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  return (
    <>
      <button
        type="button"
        className="plan-thumb"
        title={`查看方案 ${version.versionId} 大图`}
        onClick={() => setZoom(true)}
      >
        {/* SVG 为自家 planSvg 渲染器/后端 render_plan_svg 产物（非用户 HTML） */}
        <span className="plan-thumb__svg" dangerouslySetInnerHTML={{ __html: version.svg }} />
        <span className="plan-thumb__label">{version.versionId}</span>
      </button>
      {zoom && (
        <div className="preview-overlay" role="dialog" aria-modal="true" aria-label="方案大图">
          <div className="preview-overlay__backdrop" onClick={() => setZoom(false)} aria-hidden="true" />
          <div className="plan-zoom">
            <header className="plan-zoom__bar">
              <span className="plan-zoom__title">方案版本 {version.versionId}</span>
              <button type="button" className="plan-zoom__close" onClick={() => setZoom(false)} aria-label="关闭">
                ✕
              </button>
            </header>
            <div className="plan-zoom__body">
              <div className="plan-zoom__svg" dangerouslySetInnerHTML={{ __html: version.svg }} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
