/**
 * 渲染进程全局类型：window.aichBridge（preload contextBridge 暴露，见 electron/preload.ts）
 */
import type {
  AgentRequest,
  GatewayStatus,
  KeyConfigInput,
  RunOptions,
  SecretsStatus,
  SessionContent,
  SessionSummary,
  SseEventEnvelope,
  UploadedImage,
} from './contracts';

declare global {
  interface AichBridge {
    /** 查询网关状态（返回 agentService 就绪情况与渲染侧网关模式） */
    getGatewayStatus(): Promise<GatewayStatus>;
    /** 发出 AgentRequest → { requestId }（runOptions 携带 agent/model/thinking） */
    runRequest(req: AgentRequest, runOptions?: RunOptions): Promise<{ requestId: string }>;
    /** R5：历史方案完整恢复（meta.db；不可用返回 []） */
    /** R6：在途运行列表（刷新/切回后重连挂接） */
    activeRuns(): Promise<Array<{ requestId: string; sessionId: string; kind: string; prompt: string }>>;
    /** R6：重挂单个请求（终态回放） */
    reattachRun(requestId: string): Promise<void>;
    /** R6：外部链接经系统浏览器打开（仅 http/https） */
    openExternal(url: string): Promise<void>;
    /** R6-3：打开外部技能文件夹（自动创建；返回路径） */
    openSkillsDir(): Promise<string>;
    /** R6-3：重启本地服务 */
    restartService(): Promise<void>;
    /** R6-4：外部技能列表（加号菜单「选择技能」） */
    listSkills(): Promise<Array<{ name: string; description: string }>>;
    /** R6-6：保存多模型条目（全量替换+激活 id） */
    saveModels(
      entries: Array<{ id?: string; name: string; baseUrl: string; model: string; apiKey?: string; thinking?: string }>,
      activeModelId: string,
    ): Promise<SecretsStatus>;
    /** R6-14：保存多图像服务商条目（全量替换+激活 id；保存后自动重启服务） */
    saveImageModels(
      entries: Array<{ id?: string; name: string; url: string; editUrl?: string; model: string; apiKey?: string }>,
      activeImageModelId: string,
    ): Promise<SecretsStatus>;
    /** R6-14：无边框窗口控制（ZCode 同构自绘按钮） */
    windowMinimize(): Promise<void>;
    windowToggleMaximize(): Promise<void>;
    windowClose(): Promise<void>;
    getWindowChromeState(): Promise<{ isMaximized: boolean }>;
    /** 订阅窗口 chrome 状态推送（maximize/unmaximize）；返回退订函数 */
    onWindowChromeChanged(cb: (state: { isMaximized: boolean }) => void): () => void;
    /** R6-6：设置自定义会话目录（''=恢复默认） */
    setSessionsDir(dir: string): Promise<void>;
    /** R6-7：文件夹选择对话框 */
    browseSessionsDir(): Promise<string | null>;
    /** R6-9：Agent Loops 日志开关 */
    setLoopLogEnabled(enabled: boolean): Promise<void>;
    /** R6-13：单次运行工具调用轮次上限（1~200；保存后自动重启服务生效） */
    setMaxToolCalls(value: number): Promise<SecretsStatus>;
    /** R6-6：打开 Agent 日志文件夹 */
    openLogsDir(): Promise<string>;
    /** R5：上传参考图注册 → { imageId, url } */
    uploadImage(sessionId: string, dataUrl: string, name?: string): Promise<UploadedImage>;
    /** 取消流 */
    cancelRequest(requestId: string): Promise<void>;
    /** 订阅主进程转发的 SSE 事件；返回退订函数 */
    onGatewayEvent(cb: (envelope: SseEventEnvelope) => void): () => void;
    /** 会话历史列表（无 bridge 时 reject，渲染层捕获降级） */
    listSessions(): Promise<SessionSummary[]>;
    /** R6-9：删除历史会话（jsonl + meta.db 级联） */
    deleteSession(sessionId: string): Promise<{ ok: boolean; removed: number }>;
    /** R7-2 反馈：画布删除 = 仅移出画布（jsonl image 条目打 canvasRemoved 标记；对话引用与文件不动） */
    deleteSessionImage?(sessionId: string, imageId: string): Promise<{ ok: boolean }>;
    /** 读取会话完整内容（消息/图像/版本引用） */
    readSession(sessionId: string): Promise<SessionContent>;
    /** G8 兜底：file:// 图像 → dataURL（主进程白名单读取；失败抛错） */
    readImageAsDataUrl(uri: string): Promise<string>;
    /** 密钥状态（不含密钥内容；无口令方案） */
    secretsStatus(): Promise<SecretsStatus>;
    /** 保存 LLM/图像 Key 配置（保存后自动重启 agent-service 生效） */
    secretsSaveKeys(input: KeyConfigInput): Promise<SecretsStatus>;
  }

  interface Window {
    /** Electron bridge 模式存在；浏览器直开（Vite 预览）时 undefined → 渲染层走 mock */
    aichBridge?: AichBridge;
  }
}

export {};