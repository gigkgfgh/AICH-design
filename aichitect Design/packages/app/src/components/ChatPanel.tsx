/**
 * ChatPanel —— 中列对话面板（P007；R5 composer 增强：子 agent/模型/思考深度选择器 + 附件）。
 *
 * 输入区（ZCode 风格）：
 * - 附件 chips 行（图片缩略图/文本图标，可移除）
 * - 输入框 + 发送
 * - 下边缘工具条：左下 Agent 选择器；右下 📎 上传 / 模型选择 / 思考深度档位
 * - idle 形态同样携带工具条（新会话即选好 agent/model 再开工）
 */

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import type { Attachment, ChatMessage, SubAgentId, ThinkingLevel } from '../types/contracts';
import { AgentSelector, ModelSelector } from './composer/Selectors';
import { AttachmentBar, ingestFiles } from './composer/AttachmentBar';
import { PlusMenu, type SelectedSkill } from './composer/PlusMenu';
import { MarkdownContent } from './MessageContent';
import { UsageIndicator } from './UsageIndicator';
import type { SessionUsage } from '../hooks/useConversation';
import { resolveImageSrcs, SafeImage } from './SafeImage';

export interface ChatPanelProps {
  messages: ChatMessage[];
  /** 是否存在进行中的请求（加载态） */
  streaming: boolean;
  /** 提交一条用户消息（R5：携带 agent/model/thinking/attachments） */
  onSend: (text: string, options?: SendOptions) => void;
  /** 形态：idle = 空会话居中（AppShell 仅渲染中列）；work = 常规工作区。默认 work */
  variant?: 'idle' | 'work';
  /** R6-15：失败消息重试（上游接口错误时前端重发，3 次上限） */
  onRetry?: (messageId: string) => void;
  /** R6-19：主动打断/终止当前生成 */
  onStop?: () => void;
  /** R7-1：对话内图片点击 → 放大预览（Lightbox 由 App 承载） */
  onOpenImage?: (src: string) => void;
  /* ---- R5 composer 状态 ---- */
  agent?: SubAgentId;
  onAgentChange?: (v: SubAgentId) => void;
  model?: string;
  onModelChange?: (v: string) => void;
  /** R6-7：已配置模型列表（密钥管理页统一维护；空则不显示选择器） */
  configuredModels?: Array<{ id: string; model: string; name: string }>;
  attachments?: Attachment[];
  onAddAttachment?: (a: Attachment) => void;
  onRemoveAttachment?: (id: string) => void;
  /** 图片注册回调（bridge 可用时经 /v1/images） */
  onRegisterImage?: (dataUrl: string, name: string) => Promise<{ imageId: string; url: string } | null>;
  /** R6-4：选定的外部技能（加号菜单） */
  selectedSkill?: SelectedSkill | null;
  onSelectSkill?: (skill: SelectedSkill | null) => void;
  /** R6-4：加载外部技能列表（懒加载） */
  onLoadSkills?: () => Promise<Array<{ name: string; description: string }>>;
  /** R6-6：是否显示模型思考内容（设置开关） */
  showThinking?: boolean;
  /** R6-6：是否显示工具调用（设置开关） */
  showToolCalls?: boolean;
  /** R7-2：模型用量聚合（无数据不渲染指示器） */
  usage?: SessionUsage | null;
}

/** ZCode 风格可折叠区块（思考/工具调用的层级区分：小字、暗色、左侧竖线、chevron）。 */
function RevealBlock(props: { title: string; badge?: string; children: ReactElement; defaultOpen?: boolean }): ReactElement {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div className="reveal-block">
      <button type="button" className="reveal-block__head" onClick={() => setOpen((v) => !v)}>
        <span className="reveal-block__chevron">{open ? '▾' : '▸'}</span>
        {props.title}
        {props.badge && <span className="reveal-block__badge">{props.badge}</span>}
      </button>
      {open && <div className="reveal-block__body">{props.children}</div>}
    </div>
  );
}

export interface SendOptions {
  agent?: SubAgentId;
  model?: string;
  thinking?: ThinkingLevel;
  attachments?: Attachment[];
  /** R6-4：选定的外部技能（注入 prompt 头部） */
  skill?: { name: string; description: string };
}

const SUGGESTIONS = [
  '生成一张现代简约客厅表现图，自然采光，原木色调',
  '为「临水茶室」构思几个建筑意象并配图',
  '调研：材料行情与经典住宅案例',
];

export function ChatPanel(props: ChatPanelProps): ReactElement {
  const { messages, streaming, onSend, variant = 'work', onRetry, onStop } = props;
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /* R6-19 补充：拖拽/粘贴上传（与「＋ 添加附件」共用 ingestFiles 管线） */
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);

  const ingestFromFiles = useCallback(
    (files: File[]) => {
      if (streaming || files.length === 0) return;
      void ingestFiles(files, {
        onAdd: (a) => props.onAddAttachment?.(a),
        onRegisterImage: props.onRegisterImage,
        onError: (msg) => setIngestError(msg),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props 回调由 App 以 useCallback 稳定提供
    [streaming, props.onAddAttachment, props.onRegisterImage],
  );

  // Electron 默认会把拖入文件当页面导航打开（整页被替换）——全局拦截，drop 仅由 composer 接管
  useEffect(() => {
    const block = (e: globalThis.DragEvent): void => e.preventDefault();
    document.addEventListener('dragover', block);
    document.addEventListener('drop', block);
    return () => {
      document.removeEventListener('dragover', block);
      document.removeEventListener('drop', block);
    };
  }, []);

  const canSend = input.trim().length > 0 && !streaming;

  useEffect(() => {
    if (variant === 'work') {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages.length, messages[messages.length - 1]?.text, variant]);

  /** textarea 自动增高（CSS max-height 200px 限幅）。 */
  function autoResize(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  function submit(): void {
    if (!canSend) return;
    onSend(input.trim(), {
      agent: props.agent,
      model: props.model,
      attachments: props.attachments,
      skill: props.selectedSkill ?? undefined,
    });
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    submit();
  }

  /** Enter 发送 / Shift+Enter 换行；IME 组合中（中文输入法候选）不触发发送。 */
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.nativeEvent.isComposing || inputRef.current?.dataset.composing === 'true') return;
    e.preventDefault();
    submit();
  }

  const hasAttachmentChips = (props.attachments?.length ?? 0) > 0 || !!props.selectedSkill;
  const attachmentsRow = hasAttachmentChips ? (
    <div className="chat-panel__attachments">
      <div className="attachment-bar">
        {props.selectedSkill && (
          <span
            className="attachment-chip attachment-chip--skill"
            title={props.selectedSkill.description || props.selectedSkill.name}
          >
            <span className="attachment-chip__icon">⧉</span>
            <span className="attachment-chip__name">技能：{props.selectedSkill.name}</span>
            <button
              type="button"
              className="attachment-chip__remove"
              aria-label="取消选择技能"
              onClick={() => props.onSelectSkill?.(null)}
            >
              ✕
            </button>
          </span>
        )}
        <AttachmentBar attachments={props.attachments ?? []} onRemove={(id) => props.onRemoveAttachment?.(id)} />
      </div>
    </div>
  ) : null;

  /** 底边缘工具条（左加号+agent / 右 模型+思考深度）。 */
  const toolbar = (
    <div className="chat-panel__toolbar">
      <PlusMenu
        onAddAttachment={(a) => props.onAddAttachment?.(a)}
        onRegisterImage={props.onRegisterImage}
        onLoadSkills={() => props.onLoadSkills?.() ?? Promise.resolve([])}
        selectedSkill={props.selectedSkill ?? null}
        onSelectSkill={(s) => props.onSelectSkill?.(s)}
        disabled={streaming}
      />
      <AgentSelector value={props.agent ?? 'main'} onChange={(v) => props.onAgentChange?.(v)} disabled={streaming} />
      <span className="chat-panel__toolbar-spacer" />
      <ModelSelector
        value={props.model ?? ''}
        onChange={(v) => props.onModelChange?.(v)}
        configuredModels={props.configuredModels}
        disabled={streaming}
      />
    </div>
  );

  /** 拖拽上传：整个聊天面板均为落点（悬停任意位置高亮 composer）。 */
  const panelDragHandlers = {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (streaming || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setDragActive(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (dragActive) e.preventDefault(); // 允许 drop 落点
    },
    onDragLeave: () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      setIngestError(null);
      // R7-2：画布拖入的图像引用（imageId 保留参考图语义；file:// 先解析为可显示 dataURL）
      const raw = e.dataTransfer.getData('application/x-aich-image');
      if (raw) {
        try {
          const ref = JSON.parse(raw) as { imageId?: unknown; url?: unknown; name?: unknown };
          const imageId = typeof ref.imageId === 'string' ? ref.imageId : null;
          const url = typeof ref.url === 'string' ? ref.url : null;
          const name = typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : imageId;
          if (imageId && url) {
            void resolveImageSrcs([url]).then((map) => {
              props.onAddAttachment?.({
                id: `att-ref-${Date.now().toString(36)}`,
                type: 'image',
                name: name ?? imageId,
                imageId,
                url: map.get(url) ?? url,
              });
            });
            return;
          }
        } catch {
          // 非 JSON 载荷 → 按普通文件处理
        }
      }
      ingestFromFiles(Array.from(e.dataTransfer.files));
    },
  };

  const composer = (
    <div
      className={`chat-panel__composer ${variant === 'idle' ? 'chat-panel__composer--hero' : ''} ${dragActive ? 'is-dragover' : ''}`}
    >
      {ingestError && (
        <div className="chat-panel__ingest-error" role="alert">
          <span>{ingestError}</span>
          <button type="button" className="chat-panel__ingest-error__close" aria-label="关闭提示" onClick={() => setIngestError(null)}>
            ✕
          </button>
        </div>
      )}
      {attachmentsRow}
      <form className="chat-panel__form" onSubmit={handleSubmit}>
        <textarea
          ref={inputRef}
          className="chat-panel__input chat-panel__textarea"
          value={input}
          rows={1}
          placeholder={streaming ? '等待生成完成…' : '描述户型或修改指令，Enter 发送，Shift+Enter 换行'}
          disabled={streaming}
          onChange={(e) => {
            setInput(e.target.value);
            autoResize(e.target);
          }}
          onKeyDown={handleKeyDown}
          onPaste={(e) => {
            // R6-19 补充：剪贴板带文件（截图/复制的图片/文件）→ 走附件管线；纯文本走默认粘贴
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length === 0 || streaming) return;
            e.preventDefault();
            setIngestError(null);
            ingestFromFiles(files);
          }}
          onCompositionStart={() => {
            if (inputRef.current) inputRef.current.dataset.composing = 'true';
          }}
          onCompositionEnd={() => {
            if (inputRef.current) inputRef.current.dataset.composing = 'false';
          }}
          aria-label="对话输入"
          autoFocus={variant === 'idle'}
        />
        {streaming && onStop ? (
          <button className="chat-panel__send chat-panel__stop" type="button" onClick={() => onStop()} aria-label="停止生成" title="停止生成">
            ■ 停止
          </button>
        ) : (
          <button className="chat-panel__send" type="submit" disabled={!canSend}>
            发送
          </button>
        )}
      </form>
      {toolbar}
    </div>
  );

  // R7-2 反馈：用量胶囊在输入框容器外（下方独立行，参考 DeepSeek 布局），不随 composer 圆角容器；
  // 外层 zone 统一承担底部边距（胶囊行不再贴窗口底边）
  const composerBlock = (
    <div className="chat-panel__composer-zone">
      {composer}
      {props.usage && <UsageIndicator usage={props.usage} />}
    </div>
  );

  if (variant === 'idle') {
    return (
      <section className="chat-panel chat-panel--idle" aria-label="方案对话" {...panelDragHandlers}>
        <div className="chat-panel__hero">
          <h1 className="chat-panel__hero-title">AICH Design</h1>
          <p className="chat-panel__hero-sub">
            用一句话描述画面，生成建筑表现图；上传或粘贴图片可作为参考。
            左下角可切换 图像生成 / 案例调研子 agent。
          </p>
          {composerBlock}
          <div className="chat-panel__suggestions">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="chat-panel__suggestion"
                disabled={streaming}
                onClick={() =>
                  onSend(s, { agent: props.agent, model: props.model, attachments: props.attachments, skill: props.selectedSkill ?? undefined })
                }
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-panel" aria-label="方案对话" {...panelDragHandlers}>
      <div className="chat-panel__messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-msg chat-msg--${msg.role} ${msg.isError ? 'chat-msg--error' : ''}`}>
            <div className="chat-msg__role">{msg.role === 'user' ? '我' : msg.role === 'assistant' ? '助手' : '系统'}</div>
            <div className="chat-msg__bubble">
              {msg.role === 'assistant' ? (
                <div className="chat-msg__text">
                  {props.showThinking && msg.thinking && (
                    <RevealBlock title="思考过程" badge={`${msg.thinking.length} 字`}>
                      <p className="reveal-think">{msg.thinking}</p>
                    </RevealBlock>
                  )}
                  {props.showToolCalls && (msg.tools?.length ?? 0) > 0 && (
                    <RevealBlock title="工具调用" badge={`${msg.tools!.length} 次`}>
                      <ul className="reveal-tools">
                        {msg.tools!.map((t, i) => (
                          <li key={i}>
                            <code>{t.toolName}</code>
                            {t.phase === 'end' ? (t.error ? <span className="reveal-tools__err">失败</span> : <span className="reveal-tools__ok">完成</span>) : <span className="reveal-tools__run">运行中…</span>}
                          </li>
                        ))}
                      </ul>
                    </RevealBlock>
                  )}
                  <MarkdownContent text={msg.text} />
                  {msg.role === 'assistant' && msg.text === '' && streaming && (
                    <span className="chat-msg__caret" aria-hidden="true" />
                  )}
                </div>
              ) : (
                <>
                  {(msg.images?.length ?? 0) > 0 && (
                    <div className="chat-msg__imgs">
                      {msg.images!.map((src, i) => (
                        <button
                          key={i}
                          type="button"
                          className="chat-msg__img-btn"
                          title="点击放大预览"
                          onClick={() => props.onOpenImage?.(src)}
                        >
                          <SafeImage src={src} alt={`附件图片 ${i + 1}`} className="chat-msg__img" />
                        </button>
                      ))}
                    </div>
                  )}
                  {msg.text.length > 0 && <p className="chat-msg__text">{msg.text}</p>}
                </>
              )}
              {msg.dispatchedAgent && (
                <span className="chat-msg__dispatch">分派 → {msg.dispatchedAgent}</span>
              )}
              {msg.isError && msg.retry && msg.retry.attempt <= msg.retry.max && onRetry && (
                <button type="button" className="chat-msg__retry" onClick={() => onRetry(msg.id)}>
                  ↻ 重试（第 {msg.retry.attempt}/{msg.retry.max} 次）
                </button>
              )}
            </div>
          </div>
        ))}
        {streaming && (
          <div className="chat-panel__loading" role="status">
            正在思考并生成方案…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {composerBlock}
    </section>
  );
}
