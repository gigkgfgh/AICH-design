/**
 * App —— 三列工作台编排（R7-2）：
 * - 标题栏统一开关：左上 = 左侧边栏开合；右上 = 图像画布开合（细竖线与窗口按钮分隔）；
 * - 右栏 = 图像节点画布（单击放大/右键菜单/快捷键/拖拽引用）；Lightbox 统一放大预览；
 * - 图像自动入画布：上传注册成功 / 对话生成 / 手动编辑产物（ImageEditorModal）均入画布；
 * - 图生图在对话中进行，手动编辑为本地修改（保存为新版本，保留血缘）。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type MouseEvent as ReactMouseEvent } from 'react';
import Lightbox from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';
import type { Attachment, ImageVersion, SubAgentId } from './types/contracts';
import { ChatPanel } from './components/ChatPanel';
import { Sidebar } from './components/Sidebar';
import { PreviewPanel } from './components/PreviewPanel';
import { resolveImageSrcs } from './components/SafeImage';
import { ImageEditorModal } from './components/ImageEditorModal';
import { TitlebarToggle } from './components/TitlebarToggle';
import { SettingsModal } from './components/SettingsModal';
import { WindowControls } from './components/WindowControls';
import { useGateway } from './hooks/useGateway';
import { useSessions, newSessionId } from './hooks/useSessions';
import { useConversation } from './hooks/useConversation';

export function App(): ReactElement {
  const [sessionId, setSessionId] = useState<string>(() => newSessionId());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [previewPopped, setPreviewPopped] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // R6-7/R6-9：两侧栏可拖宽
  const [previewWidth, setPreviewWidth] = useState(420);
  const [sidebarWidth, setSidebarWidth] = useState(248);
  const previewDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);

  // R7-2：Lightbox 放大预览 + 图片编辑器（编辑对象与已解析 src）
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [lightboxSrcs, setLightboxSrcs] = useState<Array<{ src: string }>>([]);
  /** 当前预览对应的会话图像 id（对话内未注册图的退化分支为 null → 不显示编辑入口） */
  const [lightboxImageId, setLightboxImageId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ image: ImageVersion; src: string } | null>(null);

  const handlePreviewDragStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    previewDragRef.current = { startX: e.clientX, startW: previewWidth };
    const onMove = (ev: MouseEvent): void => {
      if (!previewDragRef.current) return;
      setPreviewWidth(Math.min(720, Math.max(320, previewDragRef.current.startW + (previewDragRef.current.startX - ev.clientX))));
    };
    const onUp = (): void => {
      previewDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [previewWidth]);

  const handleSidebarDragStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    sidebarDragRef.current = { startX: e.clientX, startW: sidebarWidth };
    const onMove = (ev: MouseEvent): void => {
      if (!sidebarDragRef.current) return;
      setSidebarWidth(Math.min(400, Math.max(200, sidebarDragRef.current.startW + (ev.clientX - sidebarDragRef.current.startX))));
    };
    const onUp = (): void => {
      sidebarDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  /* ---- R5/R6：composer 状态 ---- */
  const [agent, setAgent] = useState<SubAgentId>('main');
  const [model, setModel] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [configuredModels, setConfiguredModels] = useState<Array<{ id: string; model: string; name: string }>>([]);
  const [selectedSkill, setSelectedSkill] = useState<{ name: string; description: string } | null>(null);
  // R6-6：界面显示偏好（localStorage 持久化）
  const [uiPrefs, setUiPrefs] = useState<{ showThinking: boolean; showToolCalls: boolean }>(() => ({
    showThinking: localStorage.getItem('aich.showThinking') !== '0',
    showToolCalls: localStorage.getItem('aich.showToolCalls') !== '0',
  }));
  const handleUiPref = useCallback((key: 'showThinking' | 'showToolCalls', value: boolean) => {
    setUiPrefs((prev) => ({ ...prev, [key]: value }));
    localStorage.setItem('aich.' + key, value ? '1' : '0');
  }, []);

  const { status, client, refresh: refreshGateway } = useGateway();
  const { sessions, refresh } = useSessions();

  const onSessionTouched = useCallback(() => void refresh(), [refresh]);
  const conversation = useConversation(sessionId, client, { onSessionTouched });
  const working = conversation.hasContent;

  const resetConv = conversation.reset;
  const restoreConv = conversation.restore;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const switchSession = useCallback(
    (nextId: string) => {
      setSessionId(nextId);
      resetConv();
      setPreviewPopped(false);
      setAttachments([]);
      const bridge = window.aichBridge;
      if (bridge?.readSession) {
        void bridge
          .readSession(nextId)
          .then((content) => {
            if (content) restoreConv(content);
            // R6：重挂该会话在途请求
            if (bridge.activeRuns && bridge.reattachRun) {
              void bridge
                .activeRuns()
                .then((runs) => runs.filter((r) => r.sessionId === nextId))
                .then((runs) => {
                  if (runs.length === 0) return;
                  void Promise.all(runs.map((r) => bridge.reattachRun!(r.requestId)));
                  conversation.reattachActive(runs.map(({ requestId, kind, prompt }) => ({ requestId, kind, prompt })));
                })
                .catch(() => undefined);
            }
          })
          .catch(() => undefined);
      }
    },
    [resetConv, restoreConv, conversation],
  );

  const handleNewSession = useCallback(() => {
    switchSession(newSessionId());
  }, [switchSession]);

  // R6-9：删除历史会话（jsonl + meta.db 级联；当前会话被删则新建）
  const handleDeleteSession = useCallback(
    (sessionIdToDelete: string) => {
      void window.aichBridge?.deleteSession?.(sessionIdToDelete).then(() => {
        void refresh();
        if (sessionIdToDelete === sessionIdRef.current) handleNewSession();
      });
    },
    [refresh, handleNewSession],
  );

  // 已配置模型列表（设置面板关闭后刷新）
  useEffect(() => {
    void window.aichBridge
      ?.secretsStatus?.()
      .then((st) => setConfiguredModels(st.models.map((m) => ({ id: m.id, model: m.model, name: m.name || m.model }))))
      .catch(() => undefined);
  }, [settingsOpen]);

  // working 进入时确保右栏可见（仅 idle→working 转场触发；不干预手动收起）
  const prevWorkingRef = useRef(false);
  useEffect(() => {
    if (working && !prevWorkingRef.current && previewCollapsed) setPreviewCollapsed(false);
    prevWorkingRef.current = working;
  }, [working, previewCollapsed]);

  /**
   * R7-2：图片注册（/v1/images）成功后自动入画布——上传/粘贴/拖入的图像与对话生成同权展示。
   * meta 口径与后端 /v1/images 一致（provider:'user'）。
   */
  const registerImage = useCallback(
    (dataUrl: string, name: string): Promise<{ imageId: string; url: string } | null> => {
      const bridge = window.aichBridge;
      if (!bridge?.uploadImage) return Promise.resolve(null);
      return bridge
        .uploadImage(sessionIdRef.current, dataUrl, name)
        .then((res) => {
          if (res) {
            conversation.addRegisteredImage(res.imageId, res.url, { prompt: name || '用户上传参考图', status: 'succeeded' });
          }
          return res;
        })
        .catch(() => null);
    },
    [conversation],
  );

  /** R7-2 反馈：画布删除 = 真删除（会话 jsonl image 条目 + 磁盘文件；bridge 缺失退化为仅视图层）。
   *  先视图层移除（即时反馈），持久化异步跟随——切换/恢复会话不再死而复生。 */
  const removeCanvasImage = useCallback(
    (imageId: string) => {
      conversation.removeImage(imageId);
      void window.aichBridge
        ?.deleteSessionImage?.(sessionIdRef.current, imageId)
        .catch(() => undefined);
    },
    [conversation],
  );

  const sendMessageWithOptions = useCallback(
    (text: string, options?: Parameters<typeof conversation.sendMessage>[1]) => {
      conversation.sendMessage(text, options);
      setAttachments([]);
    },
    [conversation],
  );

  /** R7-1：Lightbox 打开（解析 file:// → dataURL，保证 dev/prod 均可显示）。 */
  const openLightbox = useCallback(
    (target: ImageVersion) => {
      const imgs = conversation.images;
      const index = Math.max(0, imgs.findIndex((img) => img.imageId === target.imageId));
      setLightboxImageId(target.imageId);
      void resolveImageSrcs(imgs.map((img) => img.url)).then((map) => {
        setLightboxSrcs(imgs.map((img) => ({ src: map.get(img.url) ?? img.url })));
        setLightboxIndex(index);
      });
    },
    [conversation.images],
  );

  /** R7-2：画布图 → 对话引用（解析为 dataURL 附件；imageId 保留参考图语义）。 */
  const referenceImage = useCallback((image: ImageVersion) => {
    void resolveImageSrcs([image.url]).then((map) => {
      const url = map.get(image.url) ?? image.url;
      setAttachments((prev) => [
        ...prev,
        {
          id: `att-ref-${Date.now().toString(36)}`,
          type: 'image',
          name: image.meta.prompt?.slice(0, 24) || image.imageId,
          imageId: image.imageId,
          url,
        },
      ]);
    });
  }, []);

  /** R7-2：打开编辑器（file:// 先解析为 dataURL）。 */
  const openEditor = useCallback((image: ImageVersion) => {
    void resolveImageSrcs([image.url]).then((map) => {
      setEditing({ image, src: map.get(image.url) ?? image.url });
    });
  }, []);

  /** 编辑保存 → 注册（新版本）→ 入画布；无 bridge 时直接以 dataURL 入画布。 */
  const handleEditorSave = useCallback(
    (dataUrl: string) => {
      const source = editing?.image;
      setEditing(null);
      if (!source) return;
      const meta = { prompt: '手动编辑', model: '本地编辑器', provider: 'local', parentImageId: source.imageId, status: 'succeeded' as const };
      const bridge = window.aichBridge;
      if (!bridge?.uploadImage) {
        conversation.addRegisteredImage(`img_edit_${Date.now().toString(36)}`, dataUrl, meta);
        return;
      }
      void bridge
        .uploadImage(sessionIdRef.current, dataUrl, `编辑-${source.imageId}.png`)
        .then((res) => {
          if (res) conversation.addRegisteredImage(res.imageId, res.url, meta);
          else conversation.addRegisteredImage(`img_edit_${Date.now().toString(36)}`, dataUrl, meta);
        })
        .catch(() => conversation.addRegisteredImage(`img_edit_${Date.now().toString(36)}`, dataUrl, meta));
    },
    [editing, conversation],
  );

  /**
   * 网关不可用原因（分项报错）：已连接为 null，否则取主进程给出的具体原因，
   * 缺失时退回兜底文案。断线不做离线兜底，UI 一律显式提示。
   */
  const gatewayErrorText =
    status && status.gateway !== 'bridge'
      ? status.error?.message ?? '本地网关未连接：对话与图像功能不可用，请在「设置」完成端点配置后重启本地服务。'
      : null;

  const idle = !working;

  const sidebarNode = sidebarCollapsed ? null : (
    <Sidebar
      sessions={sessions}
      currentSessionId={sessionId}
      onNewSession={handleNewSession}
      onSelectSession={switchSession}
      gatewayStatus={status}
      onOpenSettings={() => setSettingsOpen(true)}
      onCollapse={() => setSidebarCollapsed(true)}
      onDeleteSession={handleDeleteSession}
    />
  );

  const chatNode = (
    <ChatPanel
      messages={conversation.messages}
      streaming={conversation.streaming}
      onSend={sendMessageWithOptions}
      variant={idle ? 'idle' : 'work'}
      agent={agent}
      onAgentChange={setAgent}
      model={model}
      onModelChange={setModel}
      configuredModels={configuredModels}
      attachments={attachments}
      onAddAttachment={(a) => setAttachments((prev) => [...prev, a])}
      onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((x) => x.id !== id))}
      onRegisterImage={registerImage}
      selectedSkill={selectedSkill}
      onSelectSkill={setSelectedSkill}
      onLoadSkills={() => window.aichBridge?.listSkills?.().catch(() => []) ?? Promise.resolve([])}
      showThinking={uiPrefs.showThinking}
      showToolCalls={uiPrefs.showToolCalls}
      usage={conversation.usage}
      gatewayError={gatewayErrorText}
      onRetry={conversation.retry}
      onStop={conversation.stop}
      onOpenImage={(src) => {
        // 对话内图片 → 定位到会话图像数组中的同一图（附件/未注册图退化为仅显示该图）。
        const idx = conversation.images.findIndex((img) => img.url === src);
        if (idx >= 0) {
          openLightbox(conversation.images[idx]!);
          return;
        }
        setLightboxImageId(null);
        setLightboxSrcs([{ src }]);
        setLightboxIndex(0);
      }}
    />
  );

  const settingsNode = (
    <SettingsModal
      status={status}
      onClose={() => setSettingsOpen(false)}
      onGatewayRefresh={() => void refreshGateway()}
      uiPrefs={uiPrefs}
      onUiPrefChange={handleUiPref}
    />
  );

  // R6-14/R7-2：无边框窗口——标题栏（左上左栏开关 + 品牌 | 右上右栏开关 + 分隔线 + 窗口按钮）
  const titlebar = (
    <div className="titlebar">
      <TitlebarToggle side="left" open={!sidebarCollapsed} onClick={() => setSidebarCollapsed((v) => !v)} />
      <div className="titlebar__brand">
        <span className="titlebar__mark" aria-hidden="true" />
        AICH Design
      </div>
      <div className="titlebar__spacer" />
      <div className="titlebar__right">
        {working && <TitlebarToggle side="right" open={!previewCollapsed} onClick={() => setPreviewCollapsed((v) => !v)} />}
        {working && <div className="titlebar__divider" role="separator" />}
        <WindowControls />
      </div>
    </div>
  );

  const editorNode = editing ? (
    <ImageEditorModal src={editing.src} name={editing.image.meta.prompt || editing.image.imageId} onClose={() => setEditing(null)} onSave={handleEditorSave} />
  ) : null;

  const lightbox = (
    <Lightbox
      // v3 为受控组件：不传 open 时组件恒不渲染（此前 index/srcs 已设但页面无任何 DOM 的根因）
      open={lightboxIndex !== null}
      slides={lightboxSrcs}
      index={lightboxIndex ?? 0}
      plugins={[Zoom]}
      animation={{ zoom: 180 }}
      toolbar={{
        buttons:
          lightboxImageId !== null
            ? [
                <button
                  key="aich-edit"
                  type="button"
                  className="yarl__button"
                  title="编辑此图像"
                  onClick={() => {
                    const img = conversation.images.find((x) => x.imageId === lightboxImageId);
                    setLightboxIndex(null);
                    if (img) openEditor(img);
                  }}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ marginRight: 6, verticalAlign: '-2px' }}
                    aria-hidden="true"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                  编辑
                </button>,
              ]
            : [],
      }}
      on={{ view: ({ index }: { index: number }) => setLightboxIndex(index) }}
      close={() => setLightboxIndex(null)}
    />
  );

  // idle：侧栏（可收起/拖宽）+ 居中对话框
  if (idle) {
    return (
      <div className="app">
        {titlebar}
        <div className={`app__body app--idle ${sidebarCollapsed ? 'app--sidebar-collapsed' : ''}`}>
          {!sidebarCollapsed && sidebarNode && (
            <>
              <div className="sidebar-slot" style={{ width: sidebarWidth }} >{sidebarNode}</div>
              <div className="sidebar-resizer" onMouseDown={handleSidebarDragStart} role="separator" aria-label="拖拽调整侧栏宽度" />
            </>
          )}
          <main className="app__center">{chatNode}</main>
          {settingsOpen && settingsNode}
          {editorNode}
          {lightbox}
        </div>
      </div>
    );
  }

  // working：三列（两侧均可拖宽/收起；收起开关在标题栏）
  return (
    <div className="app">
      {titlebar}
      <div className={`app__body app--work ${sidebarCollapsed ? 'app--sidebar-collapsed' : ''}`}>
      {!sidebarCollapsed && sidebarNode && (
        <>
          <div className="sidebar-slot" style={{ width: sidebarWidth }} >{sidebarNode}</div>
          <div className="sidebar-resizer" onMouseDown={handleSidebarDragStart} role="separator" aria-label="拖拽调整侧栏宽度" />
        </>
      )}
      <main className="app__center">{chatNode}</main>
      {!previewCollapsed && (
        <>
          <div className="preview-resizer" onMouseDown={handlePreviewDragStart} role="separator" aria-label="拖拽调整画布宽度" />
          <div className="preview-dock" style={{ width: previewWidth }}>
            <PreviewPanel
              poppedOut={previewPopped}
              onTogglePopOut={() => setPreviewPopped((v) => !v)}
              imageCount={conversation.images.length}
              canvas={{
                images: conversation.images,
                loading: conversation.imageLoading,
                error: conversation.imageError,
              }}
              onOpenImage={openLightbox}
              onEditImage={openEditor}
              onReferenceImage={referenceImage}
              onRemoveImage={removeCanvasImage}
              onDuplicateImage={conversation.duplicateImage}
            />
          </div>
        </>
      )}
      {settingsOpen && settingsNode}
      {editorNode}
      {lightbox}
      </div>
    </div>
  );
}
