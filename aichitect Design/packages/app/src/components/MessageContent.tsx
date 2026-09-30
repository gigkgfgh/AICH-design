/**
 * MessageContent —— 消息正文渲染（R6 渲染升级；R7-1 方案缩略图移除）：
 * - Markdown（react-markdown + remark-gfm：标题/列表/表格/代码/链接）；
 *   来源链接可点击 → 经 IPC 系统浏览器打开（仅 http/https，不内嵌渲染进程）
 * - 安全：react-markdown 默认不解析原始 HTML（无 rehype-raw）
 */

import type { ReactElement } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
