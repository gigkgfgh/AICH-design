/**
 * App —— 三列工作台编排（R6-9）
 *
 * 布局：左 Sidebar（可拖宽/可收起，会话可删除）/ 中 ChatPanel / 右 PreviewPanel（可拖宽/可收起/可弹出）
 * 状态机：idle（侧栏 + 居中对话框）→ 首条消息后三列展开。
 * 意图分派：主 Agent 由 LLM 经 dispatch_agent 工具自主分派（useConversation），UI 显示分派徽标。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type MouseEvent as ReactMouseEvent } from 'react';
import type { Attachment, SubAgentId } from './types/contracts';
import { ChatPanel } from './components/ChatPanel';
import { PlanCanvas } from './components/PlanCanvas';
import { VersionTree } from './components/VersionTree';
import { ImageGallery } from './components/ImageGallery';
import { Sidebar } from './components/Sidebar';
import { PreviewPanel } from './components/PreviewPanel';
import type { PreviewTab } from './components/PreviewPanel';
import { SettingsModal } from './components/SettingsModal';
import { WindowControls } from './components/WindowControls';
import { useGateway } from './hooks/useGateway';
import { useSessions, newSessionId } from './hooks/useSessions';
import { useConversation } from './hooks/useConversation';

export function App(): ReactElement {
  const [sessionId, setSessionId] = useState<string>(() => newSessionId());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewTab, setPreviewTab] = useState<PreviewTab>('plan');
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [previewPopped, setPreviewPopped] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // R6-7/R6-9：两侧栏可拖宽
  const [previewWidth, setPreviewWidth] = useState(420);
  const [sidebarWidth, setSidebarWidth] = useState(248);
  const previewDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);

  const handlePreviewDragStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    previewDragRef.current = { startX: e.clientX, startW: previewWidth };
    const onMove = (ev: MouseEvent): void => {
      if (!previewDragRef.current) return;
      setPreviewWidth(Math.min(640, Math.max(320, previewDragRef.current.startW + (previewDragRef.current.startX - ev.clientX))));
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
      setPreviewTab('plan');
      setPreviewPopped(false);
      setAttachments([]);
      const bridge = window.aichBridge;
      if (bridge?.readSession) {
        void Promise.all([
          bridge.readSession(nextId).catch(() => null),
          bridge.storagePlans ? bridge.storagePlans(nextId).catch(() => []) : Promise.resolve([]),
        ]).then(([content, plans]) => {
          if (content) restoreConv(content, plans ?? []);
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
        });
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

  // working 进入时确保右栏可见（仅 idle→working 转场触发；不干预用户手动收起）
  const prevWorkingRef = useRef(false);
  useEffect(() => {
    if (working && !prevWorkingRef.current && previewCollapsed) setPreviewCollapsed(false);
    prevWorkingRef.current = working;
  }, [working, previewCollapsed]);

  // 图像产出自动切 Tab
  const lastImageCountRef = useRef(0);
  useEffect(() => {
    if (conversation.images.length > lastImageCountRef.current) {
      setPreviewTab((tab) => (tab === 'versions' ? tab : 'images'));
    }
    lastImageCountRef.current = conversation.images.length;
  }, [conversation.images.length]);

  const locateVersion = useCallback(() => {
    setPreviewCollapsed(false);
    setPreviewTab('plan');
  }, []);

  const registerImage = useCallback(
    (dataUrl: string, name: string): Promise<{ imageId: string; url: string } | null> => {
      const bridge = window.aichBridge;
      if (!bridge?.uploadImage) return Promise.resolve(null);
      return bridge.uploadImage(sessionIdRef.current, dataUrl, name).catch(() => null);
    },
    [],
  );

  const sendMessageWithOptions = useCallback(
    (text: string, options?: Parameters<typeof conversation.sendMessage>[1]) => {
      conversation.sendMessage(text, options);
      setAttachments([]);
    },
    [conversation],
  );

  const idle = !working;

  const sidebarNode = sidebarCollapsed ? (
    <button type="button" className="sidebar-rail" onClick={() => setSidebarCollapsed(false)} title="展开侧栏" aria-label="展开侧栏">
      ▶
    </button>
  ) : (
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
      versions={conversation.versions}
      variant={idle ? 'idle' : 'work'}
      onLocateVersion={locateVersion}
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
      onRetry={conversation.retry}
      onStop={conversation.stop}
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

  // R6-14：无边框窗口——顶部自绘标题栏（drag 区 + 窗口按钮），下方业务行布局
  const titlebar = (
    <div className="titlebar">
      <div className="titlebar__brand">
        <span className="titlebar__mark" aria-hidden="true" />
        AICH Design
      </div>
      <div className="titlebar__spacer" />
      <WindowControls />
    </div>
  );

  // idle：侧栏（可收起/拖宽）+ 居中对话框
  if (idle) {
    return (
      <div className="app">
        {titlebar}
        <div className={`app__body app--idle ${sidebarCollapsed ? 'app--sidebar-collapsed' : ''}`}>
          {sidebarCollapsed ? sidebarNode : <div className="sidebar-slot" style={{ width: sidebarWidth }} >{sidebarNode}</div>}
          {!sidebarCollapsed && (
            <div className="sidebar-resizer" onMouseDown={handleSidebarDragStart} role="separator" aria-label="拖拽调整侧栏宽度" />
          )}
          <main className="app__center">{chatNode}</main>
          {settingsOpen && settingsNode}
        </div>
      </div>
    );
  }

  // working：三列（两侧均可拖宽/收起）
  return (
    <div className="app">
      {titlebar}
      <div className={`app__body app--work ${sidebarCollapsed ? 'app--sidebar-collapsed' : ''}`}>
      {sidebarCollapsed ? sidebarNode : <div className="sidebar-slot" style={{ width: sidebarWidth }} >{sidebarNode}</div>}
      {!sidebarCollapsed && (
        <div className="sidebar-resizer" onMouseDown={handleSidebarDragStart} role="separator" aria-label="拖拽调整侧栏宽度" />
      )}
      <main className="app__center">{chatNode}</main>
      {!previewCollapsed && (
        <div className="preview-resizer" onMouseDown={handlePreviewDragStart} role="separator" aria-label="拖拽调整预览面板宽度" />
      )}
      <div className="preview-dock" style={!previewCollapsed ? { width: previewWidth } : undefined}>
      <PreviewPanel
        activeTab={previewTab}
        onTabChange={setPreviewTab}
        collapsed={previewCollapsed}
        onToggleCollapse={() => setPreviewCollapsed((v) => !v)}
        poppedOut={previewPopped}
        onTogglePopOut={() => setPreviewPopped((v) => !v)}
        badges={{ images: conversation.images.length, versions: conversation.versions.length }}
        planNode={
          <PlanCanvas
            plan={conversation.currentVersion?.plan ?? null}
            svg={conversation.currentVersion?.svg ?? null}
            selectedRoomId={conversation.selectedRoomId}
            onSelectRoom={conversation.selectRoom}
            onGenerateImage={conversation.generateImage}
            imageGenerating={conversation.imageLoading}
          />
        }
        imagesNode={
          <ImageGallery
            images={conversation.images}
            currentImageId={conversation.currentImage?.imageId ?? null}
            loading={conversation.imageLoading}
            error={conversation.imageError}
            onSelectImage={conversation.selectImage}
            onEditImage={conversation.editImage}
          />
        }
        versionsNode={
          <VersionTree
            versions={conversation.versions}
            currentVersionId={conversation.currentVersionId}
            onSelect={conversation.selectVersion}
            images={conversation.images}
            currentImageId={conversation.currentImage?.imageId ?? null}
            onSelectImage={conversation.selectImage}
            onRollbackToPlan={conversation.rollbackToPlanFromImage}
          />
        }
      />
      </div>
      {settingsOpen && settingsNode}
      </div>
    </div>
  );
}
